#!/bin/bash
# AlphaPulse — install dependencies and download the public front-end libraries (three.js, GSAP, Lenis, face-api)
set -e
cd "$(dirname "$0")"
npm install --omit=dev --no-audit --no-fund
[ -x node_modules/ffmpeg-static/ffmpeg ] || node node_modules/ffmpeg-static/install.js || echo "[setup] ffmpeg-static indisponible"
V=https://cdn.jsdelivr.net/npm/three@0.169.0
J=$V/examples/jsm
mkdir -p public/vendor/models public/vendor/face/model
for d in controls renderers loaders postprocessing shaders utils geometries environments; do mkdir -p public/vendor/addons/$d; done
curl -sfo public/vendor/three.module.js $V/build/three.module.min.js
for f in controls/OrbitControls.js renderers/CSS2DRenderer.js loaders/GLTFLoader.js postprocessing/EffectComposer.js postprocessing/RenderPass.js postprocessing/UnrealBloomPass.js postprocessing/OutputPass.js postprocessing/ShaderPass.js postprocessing/MaskPass.js postprocessing/Pass.js shaders/CopyShader.js shaders/LuminosityHighPassShader.js shaders/OutputShader.js utils/SkeletonUtils.js utils/BufferGeometryUtils.js geometries/RoundedBoxGeometry.js environments/RoomEnvironment.js; do
  curl -sfo public/vendor/addons/$f $J/$f
done
curl -sfo public/vendor/models/Xbot.glb https://cdn.jsdelivr.net/gh/mrdoob/three.js@r169/examples/models/gltf/Xbot.glb
F=https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15
curl -sfo public/vendor/face/face-api.esm.js $F/dist/face-api.esm.js
for m in tiny_face_detector_model face_landmark_68_model face_recognition_model; do
  curl -sfo public/vendor/face/model/$m-weights_manifest.json $F/model/$m-weights_manifest.json
  curl -sfo public/vendor/face/model/$m.bin $F/model/$m.bin
done
mkdir -p bin && curl -sfL -o bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod +x bin/yt-dlp || echo "[setup] yt-dlp indisponible"
# motion kit: GSAP (standard no-charge license) + Lenis (MIT), bundled into kit/motion.js
G=https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist
mkdir -p kit/vendor
for f in gsap ScrollTrigger SplitText; do curl -sfo kit/vendor/$f.min.js $G/$f.min.js; done
curl -sfo kit/vendor/lenis.min.js https://cdn.jsdelivr.net/npm/lenis@1.3.26/dist/lenis.min.js
for f in kit/vendor/*.js; do sed -i '/sourceMappingURL/d' $f; done
{ for f in gsap ScrollTrigger SplitText lenis; do cat kit/vendor/$f.min.js; printf '\n;\n'; done; cat kit/kit-motion.js; } > kit/motion.js
node -e "require('better-sqlite3')" && echo "[setup] ok"
