#!/usr/bin/env python3
"""
Host embeddings server for the long-term memory tier (Subteam B).

Serves an OpenAI-shape `POST /v1/embeddings` over `mlx-embeddings` (native MLX)
on the host. The in-container `memory` CLI POSTs plain text here (reached at
`host.docker.internal:<port>` via the firewall's wholesale host-gateway allow).

Model: mlx-community/bge-small-en-v1.5-bf16 (dim 384). Plain text, NO instruction
prefix (proven by the Subteam-B spike for bge-small).

  pip install -r scripts/embed-server/requirements.txt
  EMB_PORT=8084 python3 scripts/embed-server/serve-embeddings.py

LIFECYCLE: `roci start` auto-launches this as a resilient SIBLING process (see
apps/roci/src/embed-server.ts: `launchEmbedServer`), intentionally OUTSIDE the
`MODEL_TIER_SPECS` / `mlx-backend.ts` spawn machinery — that topology is hardwired
to the `mlx_lm.server` binary and a `/chat/completions` readiness probe, and is
keyed by the `CortexTier` cognition union (hindbrain/forebrain/conscious). An
embeddings server is a different binary with a different probe and is not part of
cognition. The launcher is best-effort: if this script's python env / model is
missing it logs loud and `roci start` continues (long-term memory degrades
gracefully). You can still run it standalone with the command above.
"""

import os
import time

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from mlx_embeddings import load, generate

MODEL = os.environ.get("EMB_MODEL", "mlx-community/bge-small-en-v1.5-bf16")
PORT = int(os.environ.get("EMB_PORT", "8084"))

model, tokenizer = load(MODEL)
app = FastAPI()


class Req(BaseModel):
    # OpenAI-shape: accept `input` (string or list). `text` is tolerated as an alias.
    input: list[str] | str | None = None
    text: list[str] | str | None = None


def _texts(r: "Req") -> list[str]:
    val = r.input if r.input is not None else r.text
    if val is None:
        return []
    return [val] if isinstance(val, str) else list(val)


@app.post("/v1/embeddings")
def embed(r: Req):
    texts = _texts(r)
    t = time.time()
    out = generate(model, tokenizer, texts=texts)
    emb = np.array(out.text_embeds)
    return {
        "model": MODEL,
        "dim": int(emb.shape[1]),
        "ms": round((time.time() - t) * 1000, 1),
        "data": [{"embedding": e.tolist()} for e in emb],
    }


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT)
