/*
  dither-shader.js — standalone WebGL port of the shaders.com composition
  Dither(bayer8) > [ Plasma, WaveDistortion ] used on accrease.webflow.io.

  No dependencies. One file, ~9 KB unminified. Works in WebGL2 (exact MaterialX
  Perlin hash, same as the original) and falls back to WebGL1 (float hash, same look).

  Usage:
    <canvas class="dither-shader"
      data-color-a="#0A1AFE" data-color-b="#ffffff"
      data-pixel="2" data-threshold="0.42"
      data-density="0.3" data-intensity="1.3" data-speed="0.1"
      data-wave-angle="282" data-wave-freq="5.2" data-wave-speed="0.6"
      data-wave-strength="0.05" data-wave-type="square" data-edges="mirror"></canvas>
    <script src="dither-shader.js"></script>   (or paste the file inside a <script> tag)

  Optional attributes (defaults in brackets):
    data-mobile      "static" | "animate" | "off"   [static]  behaviour on coarse-pointer devices
    data-fps         frames per second cap            [60 desktop, 30 touch]
    data-max-dpr     device-pixel-ratio cap           [2 desktop, 1.5 touch]
    data-max-pixels  cap on rendered pixels per frame [800000]
    data-pixel       device pixels per dither cell    [2]  (the canvas is rendered at 1 px per cell
                                                            and upscaled with image-rendering: pixelated)
    data-spread, data-contrast, data-balance, data-warp  — same meaning as in the original library

  Behaviour: initialises only when the canvas comes within 200 px of the viewport, pauses
  completely when off-screen or the tab is hidden, renders one still frame under
  prefers-reduced-motion, follows the canvas's CSS size through a ResizeObserver, and
  survives WebGL context loss.

  Public API: window.DitherShader.init(rootElement?), .instances, .pauseAll(), .resumeAll()
*/
(function () {
  "use strict";

  var SELECTOR = ".dither-shader";
  var mq = function (q) {
    return !!(window.matchMedia && window.matchMedia(q).matches);
  };
  var REDUCE = mq("(prefers-reduced-motion: reduce)");
  var COARSE = mq("(pointer: coarse)");

  /* ---------------------------------------------------------------- shaders */

  var VERT1 = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  var VERT2 =
    "#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

  // Exact MaterialX hash + gradient (what the original library uses). Needs GLSL ES 3.00.
  var HASH2 = [
    "uint rotl(uint x,uint k){return (x<<k)|(x>>(32u-k));}",
    "uint bjfinal(uint a,uint b,uint c){c^=b;c-=rotl(b,14u);a^=c;a-=rotl(c,11u);b^=a;b-=rotl(a,25u);c^=b;c-=rotl(b,16u);a^=c;a-=rotl(c,4u);b^=a;b-=rotl(a,14u);c^=b;c-=rotl(b,24u);return c;}",
    "uint hash3(int x,int y,int z){uint a=0xdeadbeefu+25u;uint b=a;uint c=a;a+=uint(x);b+=uint(y);c+=uint(z);return bjfinal(a,b,c);}",
    "float grad(uint h,float x,float y,float z){h&=15u;float u=h<8u?x:y;float v=h<4u?y:((h==12u||h==14u)?x:z);return ((h&1u)!=0u?-u:u)+((h&2u)!=0u?-v:v);}",
    "float perlin(vec3 p){vec3 fl=floor(p);vec3 f=p-fl;int X=int(fl.x);int Y=int(fl.y);int Z=int(fl.z);float u=fade(f.x),v=fade(f.y),w=fade(f.z);",
    " float a=mix(mix(grad(hash3(X,Y,Z),f.x,f.y,f.z),grad(hash3(X+1,Y,Z),f.x-1.,f.y,f.z),u),mix(grad(hash3(X,Y+1,Z),f.x,f.y-1.,f.z),grad(hash3(X+1,Y+1,Z),f.x-1.,f.y-1.,f.z),u),v);",
    " float b=mix(mix(grad(hash3(X,Y,Z+1),f.x,f.y,f.z-1.),grad(hash3(X+1,Y,Z+1),f.x-1.,f.y,f.z-1.),u),mix(grad(hash3(X,Y+1,Z+1),f.x,f.y-1.,f.z-1.),grad(hash3(X+1,Y+1,Z+1),f.x-1.,f.y-1.,f.z-1.),u),v);",
    " return 0.982*mix(a,b,w);}",
  ].join("\n");

  // WebGL1 fallback: same Perlin structure with a float hash (no integer ops in GLSL ES 1.00).
  var HASH1 = [
    "float hashf(vec3 p){p=fract(p*0.3183099+vec3(.1,.2,.3));p+=dot(p,p.yzx+19.19);return fract((p.x+p.y)*p.z);}",
    "float grad(float h,float x,float y,float z){float hi=floor(h*16.);float u=hi<8.?x:y;float v=hi<4.?y:((hi==12.||hi==14.)?x:z);return (mod(hi,2.)>.5?-u:u)+(mod(floor(hi/2.),2.)>.5?-v:v);}",
    "float perlin(vec3 p){vec3 fl=floor(p);vec3 f=p-fl;float u=fade(f.x),v=fade(f.y),w=fade(f.z);",
    " float a=mix(mix(grad(hashf(fl),f.x,f.y,f.z),grad(hashf(fl+vec3(1,0,0)),f.x-1.,f.y,f.z),u),mix(grad(hashf(fl+vec3(0,1,0)),f.x,f.y-1.,f.z),grad(hashf(fl+vec3(1,1,0)),f.x-1.,f.y-1.,f.z),u),v);",
    " float b=mix(mix(grad(hashf(fl+vec3(0,0,1)),f.x,f.y,f.z-1.),grad(hashf(fl+vec3(1,0,1)),f.x-1.,f.y,f.z-1.),u),mix(grad(hashf(fl+vec3(0,1,1)),f.x,f.y-1.,f.z-1.),grad(hashf(fl+vec3(1,1,1)),f.x-1.,f.y-1.,f.z-1.),u),v);",
    " return 0.982*mix(a,b,w);}",
  ].join("\n");

  var BODY = [
    "uniform vec2 uRes;uniform float uTime;uniform vec3 uColA;uniform vec3 uColB;",
    "uniform float uDensity,uIntensity,uContrast,uBalance,uWarp,uSpeed,uThreshold,uSpread;",
    "uniform float uWAngle,uWFreq,uWStrength,uWSpeed,uWType,uEdges;",
    "float fade(float t){return t*t*t*(t*(t*6.-15.)+10.);}",
    "__HASH__",
    // Plasma: volumeDomain -> warpDomain (2 levels) -> unit noise -> toneRemap -> white..black stops
    "float plasma(vec2 uv,float aspect){",
    " vec3 p=vec3(uv.x*aspect,uv.y,0.)*exp(uDensity-1.);",
    " float t=uTime*uSpeed*0.125;float amt=uWarp*4.;",
    " float qx=perlin(p+vec3(t*0.3,-t*0.2,0.));float qy=perlin(p+vec3(5.2,1.3,t*0.25));",
    " vec3 w1=p+vec3(qx,qy,0.)*amt;",
    " float rx=perlin(w1+vec3(1.7,9.2,t*0.15));float ry=perlin(w1+vec3(8.3,2.8,t*0.13));",
    " float n=perlin(p+vec3(rx,ry,0.)*amt)*0.5+0.5;",
    " float s=pow(max(n,0.),5./uIntensity);",
    " float c=clamp((s-0.5)*uContrast+0.5,0.,1.);",
    " return clamp(c+(uBalance/100.-0.5),0.,1.);}",
    // WaveDistortion
    "float waveform(float ph){float f=fract(ph/6.2831853);",
    " if(uWType<0.5)return sin(ph);if(uWType<1.5)return abs(f*4.-2.)-1.;",
    " if(uWType<2.5)return step(0.5,f)*2.-1.;if(uWType<3.5)return f*2.-1.;return abs(sin(ph));}",
    "vec2 edges(vec2 uv){if(uEdges<0.5)return clamp(uv,0.,1.);if(uEdges<1.5){vec2 m=mod(uv,2.);return 1.-abs(m-1.);}return fract(uv);}",
    // Dither: Bayer 8x8 built the same recursive way as the original
    "float quad(float a,float b){return 3.*b+2.*a-4.*a*b;}",
    "float bayer8(vec2 c){float s=mod(c.x,8.),r=mod(c.y,8.);",
    " float b0=quad(mod(s,2.),mod(r,2.));float b1=quad(floor(mod(s,4.)/2.),floor(mod(r,4.)/2.));float b2=quad(floor(s/4.),floor(r/4.));",
    " return (b0*16.+b1*4.+b2)/64.;}",
    "void main(){",
    " vec2 cell=vec2(floor(gl_FragCoord.x),uRes.y-1.-floor(gl_FragCoord.y));", // y-down like the original
    " vec2 uv=(cell+0.5)/uRes;float aspect=uRes.x/uRes.y;",
    " vec2 c=uv-0.5;float ar=radians(uWAngle);float ca=cos(ar);float sa=sin(ar);",
    " float along=(c.x*aspect)*sa+c.y*ca;",
    " float ph=(along+0.5)*uWFreq*6.2831853+uTime*uWSpeed*0.5;",
    " float disp=waveform(ph)*uWStrength*0.5;",
    " vec2 wuv=edges(uv+vec2(disp*ca/aspect,disp*sa));",
    " float g=plasma(wuv,aspect);",
    " float adj=0.5+(bayer8(cell)-0.5)*uSpread;",
    " float on=step(adj,g+(uThreshold-0.5));",
    " __OUT__=vec4(mix(uColA,uColB,on),1.);}",
  ].join("\n");

  var FRAG2 =
    "#version 300 es\nprecision highp float;precision highp int;out vec4 fragColor;\n" +
    BODY.replace("__HASH__", HASH2).replace("__OUT__", "fragColor");
  var FRAG1 =
    "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n" +
    BODY.replace("__HASH__", HASH1).replace("__OUT__", "gl_FragColor");

  /* ---------------------------------------------------------------- helpers */

  function num(v, d) {
    var n = parseFloat(v);
    return isNaN(n) ? d : n;
  }
  function pick(map, key, d) {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : d;
  }
  function parseColor(s, d) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((s || "").trim());
    if (!m) return d;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function readConfig(el) {
    var d = el.dataset || {};
    return {
      colorA: parseColor(d.colorA, [10 / 255, 26 / 255, 254 / 255]),
      colorB: parseColor(d.colorB, [1, 1, 1]),
      pixel: Math.max(1, num(d.pixel, 2)),
      threshold: num(d.threshold, 0.42),
      spread: num(d.spread, 1),
      density: num(d.density, 0.3),
      intensity: num(d.intensity, 1.3),
      contrast: num(d.contrast, 1),
      balance: num(d.balance, 50),
      warp: num(d.warp, 0.4),
      speed: num(d.speed, 0.1),
      waveAngle: num(d.waveAngle, 282),
      waveFreq: num(d.waveFreq, 5.2),
      waveSpeed: num(d.waveSpeed, 0.6),
      waveStrength: num(d.waveStrength, 0.05),
      waveType: pick(
        { sine: 0, triangle: 1, square: 2, sawtooth: 3, bounce: 4 },
        d.waveType,
        2,
      ),
      edges: pick({ clamp: 0, mirror: 1, wrap: 2 }, d.edges, 1),
      fps: num(d.fps, COARSE ? 30 : 60),
      maxDpr: num(d.maxDpr, COARSE ? 1.5 : 2),
      maxPixels: num(d.maxPixels, 800000),
      mobile: d.mobile || "static",
    };
  }
  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("dither-shader: shader compile failed\n" + log);
    }
    return sh;
  }

  /* --------------------------------------------------------------- instance */

  function Instance(canvas) {
    this.canvas = canvas;
    this.cfg = readConfig(canvas);
    this.gl = null;
    this.prog = null;
    this.u = {};
    this.running = false;
    this.inView = false;
    this.started = false;
    this.destroyed = false;
    this.elapsed = 0;
    this.lastDraw = 0;
    this.raf = 0;
    this.frames = 0;
    this.resizeRaf = 0;
    this.staticOnly = REDUCE || (COARSE && this.cfg.mobile === "static");
    this.frameBound = this.frame.bind(this);

    canvas.style.imageRendering = "pixelated";
    if (COARSE && this.cfg.mobile === "off") {
      canvas.setAttribute("data-shader-state", "off");
      return;
    }
    canvas.setAttribute("data-shader-state", "waiting");

    var self = this;
    if ("IntersectionObserver" in window) {
      this.io = new IntersectionObserver(
        function (entries) {
          self.inView = entries[0].isIntersecting;
          if (self.inView && !self.started) self.start();
          self.update();
        },
        { rootMargin: "200px" },
      );
      this.io.observe(canvas);
    } else {
      this.inView = true;
      this.start();
    }
  }

  Instance.prototype.start = function () {
    if (this.started || this.destroyed) return;
    this.started = true;
    if (!this.initGL()) return;
    var self = this;
    if ("ResizeObserver" in window) {
      this.ro = new ResizeObserver(function () {
        self.scheduleResize();
      });
      this.ro.observe(this.canvas);
    } else {
      this.onWinResize = function () {
        self.scheduleResize();
      };
      window.addEventListener("resize", this.onWinResize);
    }
    this.onVis = function () {
      self.update();
    };
    document.addEventListener("visibilitychange", this.onVis);
    this.resize();
    this.draw(); // first frame synchronously so nothing flashes
    this.canvas.setAttribute(
      "data-shader-state",
      this.staticOnly ? "static" : "running",
    );
    this.update();
  };

  Instance.prototype.initGL = function () {
    var c = this.canvas;
    var opts = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: "low-power",
    };
    var gl = c.getContext("webgl2", opts),
      v2 = !!gl;
    if (!gl)
      gl =
        c.getContext("webgl", opts) || c.getContext("experimental-webgl", opts);
    if (!gl) {
      c.setAttribute("data-shader-state", "unsupported");
      return false;
    }
    try {
      var prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, v2 ? VERT2 : VERT1));
      gl.attachShader(
        prog,
        compile(gl, gl.FRAGMENT_SHADER, v2 ? FRAG2 : FRAG1),
      );
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error(
          "dither-shader: link failed " + gl.getProgramInfoLog(prog),
        );
      gl.useProgram(prog);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        gl.STATIC_DRAW,
      );
      var loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.gl = gl;
      this.prog = prog;
      this.webgl2 = v2;
      var names = [
        "uRes",
        "uTime",
        "uColA",
        "uColB",
        "uDensity",
        "uIntensity",
        "uContrast",
        "uBalance",
        "uWarp",
        "uSpeed",
        "uThreshold",
        "uSpread",
        "uWAngle",
        "uWFreq",
        "uWStrength",
        "uWSpeed",
        "uWType",
        "uEdges",
      ];
      for (var i = 0; i < names.length; i++)
        this.u[names[i]] = gl.getUniformLocation(prog, names[i]);
      this.applyConfig();
    } catch (e) {
      console.error(e);
      c.setAttribute("data-shader-state", "error");
      return false;
    }
    var self = this;
    this.onLost = function (e) {
      e.preventDefault();
      self.stopLoop();
      self.canvas.setAttribute("data-shader-state", "lost");
    };
    this.onRestored = function () {
      if (self.initGL()) {
        self.resize();
        self.draw();
        self.update();
      }
    };
    c.addEventListener("webglcontextlost", this.onLost);
    c.addEventListener("webglcontextrestored", this.onRestored);
    return true;
  };

  Instance.prototype.applyConfig = function () {
    var gl = this.gl,
      u = this.u,
      cfg = this.cfg;
    if (!gl) return;
    gl.uniform3fv(u.uColA, cfg.colorA);
    gl.uniform3fv(u.uColB, cfg.colorB);
    gl.uniform1f(u.uDensity, cfg.density);
    gl.uniform1f(u.uIntensity, cfg.intensity);
    gl.uniform1f(u.uContrast, cfg.contrast);
    gl.uniform1f(u.uBalance, cfg.balance);
    gl.uniform1f(u.uWarp, cfg.warp);
    gl.uniform1f(u.uSpeed, cfg.speed);
    gl.uniform1f(u.uThreshold, cfg.threshold);
    gl.uniform1f(u.uSpread, cfg.spread);
    gl.uniform1f(u.uWAngle, cfg.waveAngle);
    gl.uniform1f(u.uWFreq, cfg.waveFreq);
    gl.uniform1f(u.uWStrength, cfg.waveStrength);
    gl.uniform1f(u.uWSpeed, cfg.waveSpeed);
    gl.uniform1f(u.uWType, cfg.waveType);
    gl.uniform1f(u.uEdges, cfg.edges);
  };

  // Re-read data-* attributes (after changing them) and apply.
  Instance.prototype.refresh = function () {
    this.cfg = readConfig(this.canvas);
    this.staticOnly = REDUCE || (COARSE && this.cfg.mobile === "static");
    this.applyConfig();
    this.resize();
    this.draw();
    this.update();
  };

  Instance.prototype.scheduleResize = function () {
    var self = this;
    if (this.resizeRaf) return;
    this.resizeRaf = requestAnimationFrame(function () {
      self.resizeRaf = 0;
      if (self.resize() && !self.running) self.draw();
    });
  };

  // Backing store: one rendered pixel per dither cell, upscaled by the browser.
  Instance.prototype.resize = function () {
    var c = this.canvas,
      cfg = this.cfg;
    var w = c.clientWidth,
      h = c.clientHeight;
    if (!w || !h) return false;
    var dpr = Math.min(window.devicePixelRatio || 1, cfg.maxDpr);
    var scale = dpr / cfg.pixel;
    var px = w * h * scale * scale;
    if (px > cfg.maxPixels) scale *= Math.sqrt(cfg.maxPixels / px);
    var bw = Math.max(1, Math.round(w * scale)),
      bh = Math.max(1, Math.round(h * scale));
    var changed = c.width !== bw || c.height !== bh;
    if (changed) {
      c.width = bw;
      c.height = bh;
    }
    if (this.gl) {
      this.gl.viewport(0, 0, bw, bh);
      this.gl.uniform2f(this.u.uRes, bw, bh);
    }
    return changed;
  };

  Instance.prototype.draw = function () {
    var gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    gl.uniform1f(this.u.uTime, this.elapsed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.frames++;
  };

  Instance.prototype.update = function () {
    var shouldRun =
      this.started &&
      !!this.gl &&
      this.inView &&
      !this.staticOnly &&
      !this.paused &&
      document.visibilityState !== "hidden";
    if (shouldRun && !this.running) {
      this.running = true;
      this.lastDraw = 0;
      this.raf = requestAnimationFrame(this.frameBound);
    } else if (!shouldRun && this.running) this.stopLoop();
  };

  Instance.prototype.stopLoop = function () {
    this.running = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  };

  Instance.prototype.frame = function (now) {
    this.raf = 0;
    if (!this.running) return;
    var interval = 1000 / this.cfg.fps - 1.5;
    if (!this.lastDraw) {
      this.lastDraw = now;
      this.draw();
    } else if (now - this.lastDraw >= interval) {
      this.elapsed += Math.min((now - this.lastDraw) / 1000, 0.1);
      this.lastDraw = now;
      this.draw();
    }
    this.raf = requestAnimationFrame(this.frameBound);
  };

  Instance.prototype.pause = function () {
    this.paused = true;
    this.update();
  };
  Instance.prototype.resume = function () {
    this.paused = false;
    this.update();
  };

  Instance.prototype.destroy = function () {
    this.destroyed = true;
    this.stopLoop();
    if (this.io) this.io.disconnect();
    if (this.ro) this.ro.disconnect();
    if (this.onWinResize)
      window.removeEventListener("resize", this.onWinResize);
    if (this.onVis)
      document.removeEventListener("visibilitychange", this.onVis);
    if (this.onLost) {
      this.canvas.removeEventListener("webglcontextlost", this.onLost);
      this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    }
    if (this.gl) {
      var ext = this.gl.getExtension("WEBGL_lose_context");
      if (ext) ext.loseContext();
    }
    this.gl = null;
    this.canvas.removeAttribute("data-shader-state");
  };

  /* ------------------------------------------------------------------- API */

  var API = (window.DitherShader = window.DitherShader || { instances: [] });
  API.Instance = Instance;
  API.init = function (root) {
    var nodes = (root || document).querySelectorAll(SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].__dither) continue;
      nodes[i].__dither = new Instance(nodes[i]);
      API.instances.push(nodes[i].__dither);
    }
    return API.instances;
  };
  API.pauseAll = function () {
    API.instances.forEach(function (i) {
      i.pause();
    });
  };
  API.resumeAll = function () {
    API.instances.forEach(function (i) {
      i.resume();
    });
  };
  API.destroyAll = function () {
    API.instances.forEach(function (i) {
      i.destroy();
      i.canvas.__dither = null;
    });
    API.instances.length = 0;
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", function () {
      API.init();
    });
  else API.init();
})();
