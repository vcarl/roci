"""
NeonEcho Embedding Server
OpenAI-compatible /v1/embeddings endpoint
Model: BAAI/bge-small-en-v1.5 (384 dims, ONNX, CPU)
Port: 11435
Accessible from both WSL (localhost:11435) and Windows (localhost:11435 via WSL2 port forwarding)
"""

from fastembed import TextEmbedding
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Union
import uvicorn
import time

MODEL_NAME = "BAAI/bge-small-en-v1.5"

app = FastAPI(title="NeonEcho Embed Server")
model: TextEmbedding | None = None


@app.on_event("startup")
async def load_model():
    global model
    print(f"[embed] Loading {MODEL_NAME}...")
    model = TextEmbedding(model_name=MODEL_NAME)
    # warm up
    list(model.embed(["warm"]))
    print(f"[embed] Ready on :11435")


class EmbedRequest(BaseModel):
    input: Union[str, list[str]]
    model: str = MODEL_NAME
    encoding_format: str = "float"


@app.post("/v1/embeddings")
async def embeddings(req: EmbedRequest):
    texts = [req.input] if isinstance(req.input, str) else req.input
    vecs = list(model.embed(texts))
    return {
        "object": "list",
        "model": MODEL_NAME,
        "data": [
            {"object": "embedding", "index": i, "embedding": v.tolist()}
            for i, v in enumerate(vecs)
        ],
        "usage": {
            "prompt_tokens": sum(len(t.split()) for t in texts),
            "total_tokens": sum(len(t.split()) for t in texts),
        },
    }


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_NAME, "ready": model is not None}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=11435, log_level="warning")
