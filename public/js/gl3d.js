/* gl3d.js — zero-dependency WebGL2 layer for the 3D repo galaxy (Repo3D).
   Three things live here, all scene-agnostic:
     · mat4 math + CPU point projection (labels, picking, god-ray anchor)
     · procedural sprite textures (star, glow, ring, nebula gas) — no assets
     · the HDR post chain: scene FBO → bright pass → 2-scale gaussian bloom →
       radial god rays → tonemap/vignette/grain composite. Light themes flip
       the composite into "ink mode" so the scene reads dark-on-paper.
   Repo3D (galaxy3d.js) owns all scene data and draw order; this file owns
   every GLSL string and every framebuffer. Quality gating happens by simply
   passing zero strengths — passes self-skip. */
const GL3D = (() => {
  /* ---------- mat4 (column-major) ---------- */
  function persp(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f;
    m[10] = (far + near) / (near - far); m[11] = -1;
    m[14] = (2 * far * near) / (near - far);
    return m;
  }
  function lookAt(e, c, up) {
    let fx = c[0] - e[0], fy = c[1] - e[1], fz = c[2] - e[2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    let sx = fy * up[2] - fz * up[1], sy = fz * up[0] - fx * up[2], sz = fx * up[1] - fy * up[0];
    const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
    const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
    const m = new Float32Array(16);
    m[0] = sx; m[1] = ux; m[2] = -fx;
    m[4] = sy; m[5] = uy; m[6] = -fy;
    m[8] = sz; m[9] = uz; m[10] = -fz;
    m[12] = -(sx * e[0] + sy * e[1] + sz * e[2]);
    m[13] = -(ux * e[0] + uy * e[1] + uz * e[2]);
    m[14] = (fx * e[0] + fy * e[1] + fz * e[2]);
    m[15] = 1;
    return m;
  }
  function mul(a, b) { // a×b
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  // clip-space translate (drawer insets shift the composition center)
  function clipShift(m, ox, oy) {
    const t = new Float32Array(16); t[0] = t[5] = t[10] = t[15] = 1; t[12] = ox; t[13] = oy;
    return mul(t, m);
  }
  // CPU projection of a world point -> [sx, sy, w, viewDist] in CSS px
  function project(m, x, y, z, W, H) {
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw < 0.001) return null;
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
    return [(cx * 0.5 + 0.5) * W, (1 - (cy * 0.5 + 0.5)) * H, cw];
  }

  /* ---------- shaders ---------- */
  const V = '#version 300 es\nprecision highp float;\n';
  const EASE = 'float eio(float t){t=clamp(t,0.,1.);return t<.5?4.*t*t*t:1.-pow(-2.*t+2.,3.)/2.;}\n';

  /* nodes — point sprites with morph (aFrom->aTo, per-node delay), breathing
     wobble, and vertex-level bokeh DoF: defocused stars swell + dim. */
  const VS_NODE = V + EASE + `
layout(location=0) in vec3 aFrom;
layout(location=1) in vec3 aTo;
layout(location=2) in vec3 aColor;
layout(location=3) in vec4 aMeta; // x radius, y seed, z delay, w kind (0 file / 1 dir / 2 agg) +8 when dimmed
uniform mat4 uVP; uniform vec3 uEye;
uniform float uMorph,uTime,uFocus,uDof,uPx,uSizeK,uAlphaK,uWobble,uMaxPx;
out vec3 vColor; out float vA;
void main(){
  float g=eio((uMorph-aMeta.z)/max(.2,1.-aMeta.z));
  vec3 pos=mix(aFrom,aTo,g);
  float s=aMeta.y*6.2832;
  float kdim=step(4.,aMeta.w);
  float kind=aMeta.w-kdim*8.;
  float wob=uWobble*(kind<.5?1.:.3);
  pos+=wob*vec3(sin(uTime*.6+s),sin(uTime*.83+s*1.7),cos(uTime*.71+s*2.3));
  float dist=max(length(pos-uEye),1.);
  float defo=abs(dist-uFocus)/max(uFocus,40.)*uDof;
  float size=aMeta.x*uSizeK*(1.+min(defo*1.2,2.2));
  gl_PointSize=min(size*uPx/dist,uMaxPx)*(.25+.75*g);
  gl_Position=uVP*vec4(pos,1.);
  vColor=aColor;
  vA=uAlphaK*g/(1.+defo*defo*1.8)*(1.-kdim*.85);
}`;
  const FS_NODE = V + `
uniform sampler2D uTex; uniform vec3 uTint; uniform float uTintK;
in vec3 vColor; in float vA; out vec4 o;
void main(){ float a=texture(uTex,gl_PointCoord).r*vA; o=vec4(mix(vColor,uTint,uTintK)*a,a); }`;

  /* links — endpoints carry the SAME morph/wobble inputs as their node so the
     web never detaches mid-flight. Shimmer = liquid light along every path. */
  const VS_LINE = V + EASE + `
layout(location=0) in vec3 aFrom;
layout(location=1) in vec3 aTo;
layout(location=2) in vec3 aColor;
layout(location=3) in vec4 aMeta; // x delay, y seed, z mix(0 parent,1 child), w kind
uniform mat4 uVP; uniform vec3 uEye;
uniform float uMorph,uTime,uFocus,uDof,uAlpha,uShimmer,uWobble,uFog;
out vec3 vColor; out float vA;
void main(){
  float g=eio((uMorph-aMeta.x)/max(.2,1.-aMeta.x));
  vec3 pos=mix(aFrom,aTo,g);
  float s=aMeta.y*6.2832;
  pos+=uWobble*(aMeta.w<.5?1.:.3)*vec3(sin(uTime*.6+s),sin(uTime*.83+s*1.7),cos(uTime*.71+s*2.3));
  gl_Position=uVP*vec4(pos,1.);
  float dist=max(length(pos-uEye),1.);
  float defo=abs(dist-uFocus)/max(uFocus,40.)*uDof;
  float shim=1.+uShimmer*sin(aMeta.z*16.-uTime*2.2+aMeta.y*6.2832);
  vColor=aColor*shim;
  vA=uAlpha*g*exp(-dist*uFog)/(1.+defo*defo*1.2);
}`;
  const FS_LINE = V + `
in vec3 vColor; in float vA; out vec4 o;
void main(){ o=vec4(vColor*vA,vA); }`;

  /* background stars — fixed pixel size, hash twinkle, free parallax */
  const VS_STAR = V + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aData; // x px size, y seed
uniform mat4 uVP; uniform float uTime,uPxScale,uTwk;
uniform vec3 uC1,uC2;
out vec3 vColor; out float vA;
void main(){
  gl_Position=uVP*vec4(aPos,1.);
  gl_PointSize=aData.x*uPxScale;
  float tw=1.-uTwk*(.5+.5*sin(uTime*(.4+fract(aData.y*13.7)*1.8)+aData.y*40.));
  vColor=mix(uC1,uC2,step(.5,fract(aData.y*7.31)));
  vA=tw*(.35+.65*fract(aData.y*3.17));
}`;
  const FS_STAR = V + `
uniform sampler2D uTex;
in vec3 vColor; in float vA; out vec4 o;
void main(){ float a=texture(uTex,gl_PointCoord).r*vA; o=vec4(vColor*a,a); }`;

  /* billboards (instanced) — nebula gas, core layers, comet heads, pulses */
  const VS_BILL = V + `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iA; // pos.xyz, size
layout(location=2) in vec4 iB; // color.rgb, alpha
layout(location=3) in vec4 iC; // rot, seed, spin, unused
uniform mat4 uVP; uniform vec3 uRight,uUp; uniform float uTime;
out vec2 vUv; out vec4 vCol;
void main(){
  float a=iC.x+uTime*iC.z;
  float cs=cos(a),sn=sin(a);
  vec2 r=vec2(aCorner.x*cs-aCorner.y*sn,aCorner.x*sn+aCorner.y*cs);
  vec3 w=iA.xyz+uRight*(r.x*iA.w)+uUp*(r.y*iA.w);
  gl_Position=uVP*vec4(w,1.);
  vUv=aCorner*.5+.5;
  vCol=iB;
}`;
  const FS_BILL = V + `
uniform sampler2D uTex;
in vec2 vUv; in vec4 vCol; out vec4 o;
void main(){ float a=texture(uTex,vUv).r*vCol.a; o=vec4(vCol.rgb*a,a); }`;

  /* free particles — comet trails, changed-node pulses */
  const VS_PART = V + `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in vec2 aData; // x world radius, y alpha
uniform mat4 uVP; uniform vec3 uEye; uniform float uPx,uMaxPx;
out vec3 vColor; out float vA;
void main(){
  gl_Position=uVP*vec4(aPos,1.);
  float dist=max(length(aPos-uEye),1.);
  gl_PointSize=min(aData.x*uPx/dist,uMaxPx);
  vColor=aColor; vA=aData.y;
}`;

  /* ---------- post chain ---------- */
  const VS_QUAD = V + `
layout(location=0) in vec2 aP; out vec2 vUv;
void main(){ vUv=aP*.5+.5; gl_Position=vec4(aP,0.,1.); }`;
  const FS_BRIGHT = V + `
uniform sampler2D uTex; uniform float uThresh;
in vec2 vUv; out vec4 o;
void main(){ vec3 c=texture(uTex,vUv).rgb; float l=dot(c,vec3(.299,.587,.114));
  o=vec4(c*smoothstep(uThresh,uThresh+.55,l),1.); }`;
  const FS_BLUR = V + `
uniform sampler2D uTex; uniform vec2 uDir;
in vec2 vUv; out vec4 o;
void main(){
  vec3 c=texture(uTex,vUv).rgb*.227;
  c+=texture(uTex,vUv+uDir*1.385).rgb*.316; c+=texture(uTex,vUv-uDir*1.385).rgb*.316;
  c+=texture(uTex,vUv+uDir*3.231).rgb*.070; c+=texture(uTex,vUv-uDir*3.231).rgb*.070;
  o=vec4(c,1.); }`;
  const FS_RAYS = V + `
uniform sampler2D uTex; uniform vec2 uLight; uniform float uDecay;
in vec2 vUv; out vec4 o;
void main(){
  vec2 d=(uLight-vUv)/36.;
  vec2 p=vUv; vec3 acc=vec3(0.); float w=1.,tw=0.;
  for(int i=0;i<36;i++){ p+=d; acc+=texture(uTex,p).rgb*w; tw+=w; w*=uDecay; }
  o=vec4(acc/tw,1.); }`;
  const FS_COMP = V + `
uniform sampler2D uScene,uB1,uB2,uRays;
uniform vec3 uBg,uRayCol,uWaveCol;
uniform float uB1k,uB2k,uRayK,uExpo,uVig,uLight,uTime,uGrain,uAspect,uWaveW;
uniform vec4 uWave[4]; // xy = center (uv), z = radius, w = strength (0 = off) — dirty-file shockwaves
in vec2 vUv; out vec4 o;
void main(){
  vec2 uv=vUv; float rim=0.;
  for(int i=0;i<4;i++){
    float s=uWave[i].w;
    if(s<.001) continue;
    vec2 d=vec2((vUv.x-uWave[i].x)*uAspect, vUv.y-uWave[i].y); // circular in screen space
    float dist=length(d);
    float x=(dist-uWave[i].z)/uWaveW; // front thickness — the Appearance "ping" slider
    float w=exp(-x*x);              // gaussian band at the wavefront
    if(w<.004) continue;
    vec2 dir=d/max(dist,1e-4);
    uv-=vec2(dir.x/uAspect,dir.y)*(w*s*.06); // light bulges back toward the source
    rim+=w*s;
  }
  vec3 sc;
  if(rim>.003){                     // chromatic split where the front bends the light
    vec2 ca=(uv-vUv)*.35;
    sc=vec3(texture(uScene,uv+ca).r,texture(uScene,uv).g,texture(uScene,uv-ca).b);
  } else sc=texture(uScene,uv).rgb;
  vec3 hdr=sc
    + texture(uB1,uv).rgb*uB1k
    + texture(uB2,uv).rgb*uB2k
    + texture(uRays,uv).rgb*uRayCol*uRayK;
  vec3 m=vec3(1.)-exp(-hdr*uExpo);
  float lum=dot(m,vec3(.299,.587,.114));
  vec3 col = uLight>.5
    ? uBg*(1.-clamp(lum*1.55,0.,.95))+m*.45
    : uBg+m;
  vec2 q=vUv-.5; col*=1.-dot(q,q)*uVig;
  col+=uWaveCol*rim*.34;            // tinted wavefront line — visible, not blinding
  col+=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233))+uTime)*43758.5453)-.5)*uGrain;
  o=vec4(col,1.); }`;

  /* ---------- compile / buffers ---------- */
  function sh(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('gl3d shader:', gl.getShaderInfoLog(s));
    return s;
  }
  function prog(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error('gl3d link:', gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const inf = gl.getActiveUniform(p, i); u[inf.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, inf.name); }
    return { p, u };
  }
  const buf = (gl, data, dynamic) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    return b;
  };
  const sub = (gl, b, data) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data); };
  const attr = (gl, loc, b, size, divisor = 0) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc, divisor);
  };

  /* ---------- procedural sprites (R8) ---------- */
  function texR(gl, size, fn) {
    const d = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1, ny = (y / (size - 1)) * 2 - 1;
      d[y * size + x] = Math.max(0, Math.min(255, Math.round(fn(nx, ny, Math.hypot(nx, ny)) * 255)));
    }
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const rnd2 = (x, y, s) => { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
  function fbm(x, y, s) { // 4-octave value noise, bilinear-smoothed
    let v = 0, a = 0.5;
    for (let o = 0; o < 4; o++) {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
      const n = rnd2(xi, yi, s) * (1 - u) * (1 - w) + rnd2(xi + 1, yi, s) * u * (1 - w)
        + rnd2(xi, yi + 1, s) * (1 - u) * w + rnd2(xi + 1, yi + 1, s) * u * w;
      v += n * a; a *= 0.5; x *= 2.07; y *= 2.07;
    }
    return v;
  }
  function makeTextures(gl) {
    const star = texR(gl, 128, (nx, ny, r) => {
      const core = Math.exp(-r * r * 9);
      const sx = Math.exp(-Math.abs(ny) * 46) * Math.exp(-Math.abs(nx) * 2.6);
      const sy = Math.exp(-Math.abs(nx) * 46) * Math.exp(-Math.abs(ny) * 2.6);
      return Math.min(1, core + 0.85 * (sx + sy));
    });
    const neb = (seed) => texR(gl, 192, (nx, ny, r) => {
      const m = Math.max(0, 1 - r);
      return Math.pow(fbm(nx * 2.6 + seed * 9, ny * 2.6 - seed * 7, seed), 1.7) * m * m * 1.5;
    });
    return {
      dot: texR(gl, 64, (nx, ny, r) => Math.min(1, 1.25 * Math.exp(-r * r * 6))),
      glow: texR(gl, 64, (nx, ny, r) => Math.exp(-r * r * 3.1) * (1 - r * 0.25)),
      star,
      ring: texR(gl, 128, (nx, ny, r) => Math.exp(-Math.pow((r - 0.68) / 0.085, 2))),
      neb1: neb(1.7), neb2: neb(4.2), neb3: neb(8.9),
    };
  }

  /* ---------- FBOs + post pipeline ---------- */
  function makePost(gl, hdr) {
    const IF = hdr ? gl.RGBA16F : gl.RGBA8, TY = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    function fb(w, h) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, IF, w, h, 0, gl.RGBA, TY, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { f, t, w, h };
    }
    const P = {
      bright: prog(gl, VS_QUAD, FS_BRIGHT),
      blur: prog(gl, VS_QUAD, FS_BLUR),
      rays: prog(gl, VS_QUAD, FS_RAYS),
      comp: prog(gl, VS_QUAD, FS_COMP),
    };
    const quadB = buf(gl, new Float32Array([-1, -1, 3, -1, -1, 3]));
    const quadVAO = gl.createVertexArray();
    gl.bindVertexArray(quadVAO);
    attr(gl, 0, quadB, 2);
    gl.bindVertexArray(null);

    const ZERO16 = new Float32Array(16), WHITE3 = [1, 1, 1];
    let scene = null, bA = null, bB = null, bC = null, bD = null, rays = null, W = 0, H = 0;
    function size(w, h) {
      if (w === W && h === H && scene) return;
      W = w; H = h;
      for (const o of [scene, bA, bB, bC, bD, rays]) if (o) { gl.deleteTexture(o.t); gl.deleteFramebuffer(o.f); }
      scene = fb(w, h);
      const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
      const qw = Math.max(2, w >> 2), qh = Math.max(2, h >> 2);
      bA = fb(hw, hh); bB = fb(hw, hh);
      bC = fb(qw, qh); bD = fb(qw, qh);
      rays = fb(qw, qh);
    }
    function begin() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f);
      gl.viewport(0, 0, scene.w, scene.h);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    function pass(pr, out, set) {
      gl.useProgram(pr.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.f : null);
      gl.viewport(0, 0, out ? out.w : gl.drawingBufferWidth, out ? out.h : gl.drawingBufferHeight);
      set(pr.u);
      gl.bindVertexArray(quadVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }
    const bind = (unit, tex) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); };
    function run(o) {
      gl.disable(gl.BLEND);
      const fxOn = o.b1 > 0.001 || o.b2 > 0.001 || o.rayK > 0.001;
      if (fxOn) {
        pass(P.bright, bA, (u) => { bind(0, scene.t); gl.uniform1i(u.uTex, 0); gl.uniform1f(u.uThresh, o.thresh); });
        pass(P.blur, bB, (u) => { bind(0, bA.t); gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, 1 / bA.w, 0); });
        pass(P.blur, bA, (u) => { bind(0, bB.t); gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, 0, 1 / bA.h); });
        pass(P.blur, bC, (u) => { bind(0, bA.t); gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, 1.6 / bC.w, 0); });
        pass(P.blur, bD, (u) => { bind(0, bC.t); gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, 0, 1.6 / bC.h); });
        pass(P.rays, rays, (u) => {
          bind(0, bD.t); gl.uniform1i(u.uTex, 0);
          gl.uniform2f(u.uLight, o.rayPos[0], o.rayPos[1]);
          gl.uniform1f(u.uDecay, 0.948);
        });
      }
      pass(P.comp, null, (u) => {
        bind(0, scene.t); bind(1, bA.t); bind(2, bD.t); bind(3, rays.t);
        gl.uniform1i(u.uScene, 0); gl.uniform1i(u.uB1, 1); gl.uniform1i(u.uB2, 2); gl.uniform1i(u.uRays, 3);
        gl.uniform3fv(u.uBg, o.bg); gl.uniform3fv(u.uRayCol, o.rayCol);
        gl.uniform1f(u.uB1k, fxOn ? o.b1 : 0); gl.uniform1f(u.uB2k, fxOn ? o.b2 : 0); gl.uniform1f(u.uRayK, fxOn ? o.rayK : 0);
        gl.uniform1f(u.uExpo, o.expo); gl.uniform1f(u.uVig, o.vig); gl.uniform1f(u.uLight, o.light);
        gl.uniform1f(u.uTime, o.time % 7.31); gl.uniform1f(u.uGrain, o.grain);
        gl.uniform4fv(u.uWave, o.waves || ZERO16);
        gl.uniform3fv(u.uWaveCol, o.waveCol || WHITE3);
        gl.uniform1f(u.uAspect, o.aspect || 1);
        gl.uniform1f(u.uWaveW, o.waveW || 0.022);
      });
      gl.enable(gl.BLEND);
    }
    return { size, begin, run, sceneSize: () => [W, H] };
  }

  /* ---------- boot ---------- */
  function boot(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) return null;
    const hdr = !!gl.getExtension('EXT_color_buffer_float');
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive everywhere; the composite owns the bg
    return {
      gl, hdr,
      T: makeTextures(gl),
      P: {
        node: prog(gl, VS_NODE, FS_NODE),
        line: prog(gl, VS_LINE, FS_LINE),
        star: prog(gl, VS_STAR, FS_STAR),
        bill: prog(gl, VS_BILL, FS_BILL),
        part: prog(gl, VS_PART, FS_STAR),
      },
      post: makePost(gl, hdr),
    };
  }

  return { boot, buf, sub, attr, persp, lookAt, mul, clipShift, project };
})();
