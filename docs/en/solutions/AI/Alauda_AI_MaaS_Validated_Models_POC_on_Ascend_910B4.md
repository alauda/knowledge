---
products:
   - Alauda AI
kind:
   - Article
---

# Alauda AI MaaS Proof of Concept: Validated Models on Ascend 910B4

> **Status: DRAFT.** This article documents an in-progress Model-as-a-Service (MaaS) proof of concept.
> Performance numbers below are measured; sections marked _TODO_ will be enriched in follow-up updates.

## Overview

This proof of concept validates serving production-grade open large language models through the
**Alauda AI MaaS** OpenAI-compatible gateway on **Huawei Ascend 910B4 NPUs**, end to end:
model packaging (ModelCar), deployment (KServe `LLMInferenceService` + InferNex), inference runtime
(`vllm-ascend`), and access through the MaaS gateway with API-key authentication and token rate limiting.

Two representative models were selected to cover two distinct modern architectures:

- **Qwen3.6-27B** (W8A8) — a hybrid linear-attention (Gated DeltaNet) model with native multi-token prediction.
- **DeepSeek-V4-Flash** (W4A8) — a 256-expert MoE with MLA + sparse (DSA) attention and multi-token prediction.

## Environment

| Item | Value |
|---|---|
| Hardware | Single node, 8 × Ascend 910B4, **32 GB HBM per card** (256 GB total), driver 25.5.0 |
| Inference runtime | `vllm-ascend` (release-pinned `v0.22.1rc` line) |
| Serving | KServe `LLMInferenceService` (aggregated) + InferNex bridge, native ModelCar (`oci://`) |
| MaaS gateway | OpenAI-compatible ingress (Envoy), API-key (`sk-...`) auth + per-subscription token rate limiting |
| Routing | Hermes EPP (load-aware) in front of replicas |

## Validated Models

| | Qwen3.6-27B | DeepSeek-V4-Flash |
|---|---|---|
| Architecture | `qwen3_5` — Gated DeltaNet 3:1 hybrid linear attention + full attention + native MTP | `deepseek_v4` — 256-expert MoE (6+1 active) + MLA + DSA sparse attention + MTP |
| Parameters | 27.78 B | sparse MoE (W4A8 weights ≈ 151 GB) |
| Quantization | W8A8 (weights ≈ 33 GB) | W4A8 (experts int4 / attention int8) |
| Context | 256K | 1M (YaRN) |
| Deployment topology | Aggregated, 8 cards (e.g. 2 × TP4) | Single instance, TP=8 + expert parallel |
| Source weights | `Eco-Tech/Qwen3.6-27B-w8a8` (ModelScope, Apache-2.0) | `gdydems/DeepSeek-V4-Flash-w4a8-mtp` (ModelScope, MIT) — _see Known Limitations_ |

## Test Methodology

Both models were benchmarked with **aiperf** under a closed-loop, concurrency-4 workload, using
identical traces, tokenizers and seeds across runs. Each scenario was repeated **n=3** to measure
run-to-run stability.

| Scenario | Shape | Description |
|---|---|---|
| Scenario 1 | ~8K input / 128 output | Fixed-length system-prompt reuse (chat) |
| Scenario 2 | ~17.5K input / 128 output | Long multi-turn context (chat) |

- Concurrency: 4; requests per run: 240; warmup: 4.
- Throughput (TPS) is reported as **total tokens (input + output) / wall time** to align with the
  reference baseline; decode throughput (output-only) is listed separately.

## Performance Results (measured)

### Qwen3.6-27B (W8A8), 8 × 910B4, aggregated, n=3

| Scenario | TTFT | ITL | E2E | Decode (out) | TPS (in+out) | Success |
|---|---|---|---|---|---|---|
| 1 (8K) | 1509 ± 65 ms | 32.0 ± 1.1 ms | 5577 ± 199 ms | 91.3 ± 3.1 tok/s | 5807 ± 197 | 3/3 × 240/240 |
| 2 (17.5K) | 3999 ± 308 ms | 45.3 ± 3.1 ms | 9751 ± 700 ms | 52.5 ± 3.5 tok/s | 7408 ± 487 | 3/3 × 240/240 |

ITL is highly reproducible across runs (~3%); TTFT varies ~4–8% (prefill queueing at concurrency 4).

### DeepSeek-V4-Flash (W4A8), 8 × 910B4, TP=8 + EP, n=3

| Scenario | TTFT | ITL | Decode (out) | TPS (in+out) | Success |
|---|---|---|---|---|---|
| 1 (8K) | 3.76 s | 91 ms | 33.4 tok/s | 2123 | 3/3, 0 engine restarts |
| 2 (17.5K) | 9.79 s | 182 ms | 15.5 tok/s | 2189 | 3/3, 0 engine restarts |

> _TODO: add accuracy / quality evaluation results (lm-eval) for both models._

## MaaS Gateway Access Results

The same Scenario 1 / Scenario 2 workloads were re-run **through the MaaS gateway** (OpenAI-compatible
`/v1/chat/completions`, API-key auth, token rate limit) instead of directly against the inference service,
to validate the production access path.

| Scenario | Direct (inference service) | Via MaaS gateway |
|---|---|---|
| Scenario 1 (~8K) | OK | **OK** |
| Scenario 2 (~17.5K) | OK | **Blocked** — request body exceeds the gateway request-body buffer limit |

**Finding:** the long-context Scenario 2 request body exceeds the MaaS gateway's request-body buffer
limit (stream-dependent, on the order of tens of KB), and the gateway stops responding rather than
returning an error. Scenario 1 is within the limit and works normally.

**Remediation:** raise the request-body buffer limit on the gateway's Envoy `ClientTrafficPolicy`
(`bufferLimit`) to accommodate large prompts. _TODO: document the exact policy change and re-validate
Scenario 2 after the limit is raised._

## Known Limitations

- **DeepSeek-V4-Flash quantization source.** The validated W4A8 weights are a community quantization
  (`gdydems/DeepSeek-V4-Flash-w4a8-mtp`), not a vendor or first-party build. On Ascend 910B4 the original
  FP8 weights cannot run natively (no native FP8), and the only authoritative-publisher W8A8 build does not
  fit a single 256 GB node, so an INT4 (W4A8) build is required to fit. _TODO: confirm the quantization
  provenance / re-quantization plan acceptable for the POC._
- **Prefix caching is disabled** for both models (required by the hybrid/sparse attention designs), so
  large-prompt reuse does not benefit from prefix-cache reuse.
- MaaS-gateway access has so far been validated for **DeepSeek-V4-Flash**; the Qwen3.6-27B gateway path is
  _TODO_.

## To Be Enriched (draft checklist)

- [ ] Accuracy / quality evaluation (lm-eval) for both models
- [ ] MaaS-gateway access results for Qwen3.6-27B
- [ ] Re-validate Scenario 2 through the gateway after raising the request-body buffer limit
- [ ] Architecture / deployment diagram
- [ ] Screenshots: MaaS console, token-usage dashboard
- [ ] Resolve the DeepSeek-V4-Flash quantization-source decision
- [ ] Capacity / scaling notes (replicas, SLO targets)
