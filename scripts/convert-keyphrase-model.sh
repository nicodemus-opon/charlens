#!/bin/sh
# One-time ONNX conversion for the Phase-2 keyphrase model (TAG_MODEL_ENABLED=1).
#
# ml6team/keyphrase-extraction-distilbert-inspec ships PyTorch weights only;
# Transformers.js needs ONNX. Run this on any machine with Python, then push
# the result to a HF repo (or mount it as a local dir) and set:
#   TAG_MODEL_NAME=<your-hf-user>/keyphrase-extraction-distilbert-inspec-onnx
#
# Requires: pip install "optimum[onnxruntime]" huggingface_hub
set -eu

MODEL=${1:-ml6team/keyphrase-extraction-distilbert-inspec}
OUT=${2:-./models/keyphrase-extraction-distilbert-inspec-onnx}

optimum-cli export onnx --model "$MODEL" --task token-classification "$OUT"

# Quantized weights (~65MB) are what `pipeline(..., { quantized: true })` loads.
python - "$OUT" <<'PY'
import sys
from optimum.onnxruntime import ORTModelForTokenClassification
from optimum.onnxruntime.configuration import AutoQuantizationConfig
from optimum.onnxruntime import ORTQuantizer

out = sys.argv[1]
q = ORTQuantizer.from_pretrained(out)
q.quantize(save_dir=out, quantization_config=AutoQuantizationConfig.avx512_vnni(is_static=False))
PY

echo "Converted -> $OUT"
echo "Upload (optional): huggingface-cli upload <your-repo> $OUT"
echo "Then set TAG_MODEL_ENABLED=1 and TAG_MODEL_NAME=<your-repo> (reuses EMBED_CACHE_DIR)."
