"""One-off: export a sentence-transformers model to ONNX (int8) for the API. Needs PyTorch (dev only).

    uv run --with torch --with sentence-transformers --with onnx \\
        python api/export_embedder.py ~/.cache/huggingface/hub/models--sentence-transformers--multi-qa-MiniLM-L6-cos-v1/snapshots/<hash>

Writes api/assets/embed/model.onnx and tokenizer.json, then checks the ONNX output against PyTorch.
"""
import sys
from pathlib import Path

import numpy as np
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
from sentence_transformers import SentenceTransformer
from transformers import AutoModel, AutoTokenizer

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from api.embeddings import EMBED_DIR, Embedder  # noqa: E402

src = Path(sys.argv[1]).expanduser()
EMBED_DIR.mkdir(parents=True, exist_ok=True)
class Encoder(torch.nn.Module):
    """Wraps the transformer so ONNX export passes inputs by name (newer transformers reorder positional args)."""

    def __init__(self, bert):
        super().__init__()
        self.bert = bert

    def forward(self, input_ids, attention_mask, token_type_ids):
        return self.bert(input_ids=input_ids, attention_mask=attention_mask,
                         token_type_ids=token_type_ids).last_hidden_state


model = Encoder(AutoModel.from_pretrained(src)).eval()
tokenizer = AutoTokenizer.from_pretrained(src)
example = tokenizer(["export example", "a second, longer example sentence"], padding=True, return_tensors="pt")
fp32 = EMBED_DIR / "model-fp32.onnx"
names = ["input_ids", "attention_mask", "token_type_ids"]
torch.onnx.export(model, tuple(example[n] for n in names), fp32, input_names=names,
                  output_names=["last_hidden_state"], opset_version=17, dynamo=False,
                  dynamic_axes={n: {0: "batch", 1: "seq"} for n in names + ["last_hidden_state"]})
quantize_dynamic(str(fp32), str(EMBED_DIR / "model.onnx"), weight_type=QuantType.QInt8, per_channel=True)  # ~0.99 cosine to PyTorch, 23 MB
fp32.unlink()
(EMBED_DIR / "tokenizer.json").write_bytes((src / "tokenizer.json").read_bytes())

texts = ["Develop web applications with React and TypeScript.", "Care for patients on a hospital ward.",
         "Prepare budgets and financial statements.", "Teach mathematics to high school students."]
reference = SentenceTransformer(str(src)).encode(texts, normalize_embeddings=True)
onnx = Embedder().encode(texts)
print("cosine(ONNX int8, PyTorch) per text:", np.round((onnx * reference).sum(axis=1), 4))
print("max difference in pairwise similarities:", round(float(np.abs(onnx @ onnx.T - reference @ reference.T).max()), 4))
