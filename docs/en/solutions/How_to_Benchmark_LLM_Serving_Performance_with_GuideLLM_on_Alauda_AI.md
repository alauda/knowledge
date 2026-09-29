---
kind:
   - Article
products:
   - Alauda AI
---

# How to Benchmark LLM Serving Performance with GuideLLM on Alauda AI

## Purpose

This article describes a repeatable method for measuring the serving performance of a large language model (LLM) deployed on Alauda AI. It uses an OpenAI-compatible model endpoint and GuideLLM to generate a constant request rate, collect latency and throughput metrics, and preserve the complete test context with the result.

The method is intended for capacity studies, configuration comparisons, and model cards. It measures the model serving path directly. It does not measure retrieval quality, answer correctness, prompt safety, or the end-to-end latency of an application gateway unless that gateway is deliberately selected as the benchmark target.

## Test Architecture

The test has three independently versioned parts:

1. **Model server**: the model runtime deployed on Alauda AI. It exposes an OpenAI-compatible `/v1/chat/completions` or `/v1/completions` endpoint.
2. **Benchmark client**: GuideLLM, run from a separate client pod or host with enough network capacity to generate the requested load.
3. **Evidence store**: the GuideLLM JSON output and a metadata document containing the model, runtime, hardware, configuration, workload, and timestamp.

Keep the benchmark client off the inference node when possible. Otherwise, client CPU, memory, or network contention can be mistaken for model-serving latency.

## Prerequisites

Before starting the benchmark, confirm the following:

- The model is deployed and ready on Alauda AI.
- The target endpoint is reachable from the benchmark client.
- The endpoint returns a valid OpenAI-compatible response for a single request.
- The model server, runtime image, tokenizer, and accelerator driver versions are recorded.
- No unrelated load, autoscaling event, rolling update, or model warm-up is occurring during a measured run.
- The GuideLLM package version is pinned. GuideLLM APIs and result schemas can change between releases.

Verify the endpoint with a small Python request. Do not use this request as benchmark data:

```python
import os

import httpx


response = httpx.post(
    "http://model-service:8000/v1/chat/completions",
    json={
        "model": "<served-model-name>",
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "max_tokens": 8,
        "temperature": 0,
    },
    timeout=60,
)
response.raise_for_status()
print(response.json())
```

The target in this procedure is the model Service directly, so no API key is
needed by default. Add authentication only when an authorization proxy has been
placed in front of that Service.

Warm the model before collecting measurements. A warm-up should exercise the same endpoint, tokenizer, model parameters, and approximate input/output shape as the measured workload. Exclude warm-up requests from the reported result.

## Define the Workloads

Synthetic workloads make comparisons reproducible because the input and output token counts are explicit. Select a workload that represents the intended use case and record the choice in the result metadata.

| Workload | Input tokens | Output tokens | Typical use |
| --- | ---: | ---: | --- |
| Chat | 512 | 256 | General conversational requests |
| Code fixing | 1,024 | 1,024 | Code diagnosis and patch generation |
| RAG | 4,096 | 512 | Retrieval-augmented question answering |
| Long RAG | 10,240 | 1,536 | Long-context retrieval and synthesis |

The values above are starting points, not universal service-level objectives. If production traffic has a different distribution, add a separate workload and document its token distribution. Do not compare two configurations when their input/output shapes, sampling settings, or stop conditions differ.

## Run a Constant-Rate Sweep

An open-loop constant-rate test sends requests at a configured rate regardless of the previous request's completion time. It shows how latency and completed throughput change as offered load increases. Run each workload at a sequence of request rates, for example 1 through 9 requests per second (RPS), and keep the duration and error policy constant for every rate.

Install GuideLLM in a virtual environment and pin the version used for the experiment. GuideLLM supports Python 3.10 through 3.13. The `recommended` extra includes the tokenizer and performance dependencies commonly needed for model serving benchmarks:

```bash
python3.12 -m venv .venv-guidellm
source .venv-guidellm/bin/activate
python -m pip install --upgrade pip
python -m pip install "guidellm[recommended]==<pinned-version>"
```

Use a measured duration of at least 300 seconds for a stable run; a longer duration is preferable for production comparisons. A sliding-window error-rate constraint can be configured in the Python scenario. A run that stops early must be marked as incomplete and must not be presented as a full-duration result.

## Python Runner Example

The script below uses GuideLLM as a Python package. It creates a scenario object, sends requests to an OpenAI-compatible endpoint, and writes one JSON report per RPS value. It runs each rate in a separate event loop so that the output directories remain independent.

The API shape shown below targets the current `0.7.x` package. Keep the package version and this example aligned; do not mix configuration objects from different releases.

```python
#!/usr/bin/env python3
"""Run a constant-rate GuideLLM sweep through the Python API."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from guidellm.benchmark import BenchmarkScenario, benchmark_generative_text

TARGET = os.environ["MODEL_URL"]
MODEL = os.environ["MODEL_NAME"]
OUTPUT_DIR = Path(os.environ.get("GUIDELLM_OUTPUT_DIR", "./guidellm-results"))
INPUT_TOKENS = 512
OUTPUT_TOKENS = 256
DURATION_SECONDS = 300
RATES = (1, 2, 3, 4, 5, 6, 7, 8, 9)

async def run_rate(rate: int) -> None:
    output_dir = OUTPUT_DIR / f"rate-{rate}"
    output_dir.mkdir(parents=True, exist_ok=True)
    scenario = BenchmarkScenario.create(
        scenario=None,
        spec={
            "backend": {
                "kind": "openai_http",
                "target": TARGET,
                "model": MODEL,
            },
            "profile": {"kind": "constant", "rate": rate},
            "constraints": [
                {"kind": "max_duration", "seconds": DURATION_SECONDS},
                {"kind": "max_error_rate", "rate": 0.5},
            ],
            "data": [
                {
                    "kind": "synthetic_text",
                    "prompt_tokens": INPUT_TOKENS,
                    "prompt_tokens_stdev": max(1, int(INPUT_TOKENS * 0.1)),
                    "output_tokens": OUTPUT_TOKENS,
                    "output_tokens_stdev": max(1, int(OUTPUT_TOKENS * 0.1)),
                }
            ],
            "outputs": [
                {"kind": "json", "path": str(output_dir / "benchmarks.json")}
            ],
            "seed": {"kind": "static", "value": 42},
        },
    )
    await benchmark_generative_text(scenario)


def main() -> None:
    for rate in RATES:
        asyncio.run(run_rate(rate))


if __name__ == "__main__":
    main()
```

If an authorization proxy is intentionally placed in front of the model Service,
configure its authentication fields using the pinned package's Python schema and
read the secret from an environment variable or mounted Secret. Do not hard-code
credentials in the script or result file.

## Metrics to Report

Extract the values from the raw GuideLLM result instead of recomputing them from rounded table values.

| Metric | Meaning | How to use it |
| --- | --- | --- |
| TTFT (time to first token) | Time from request submission until the first streamed token | Initial responsiveness; strongly affected by queueing and prefill |
| ITL (inter-token latency) | Delay between consecutive generated tokens after the first token | Decode smoothness and streaming experience |
| E2E latency | Time from request submission until the final token | Complete request latency |
| Request rate | Offered and completed requests per second | Compare requested load with the rate the service actually completes |
| Output token throughput | Generated output tokens per second | Overall generation capacity; report aggregate and, when useful, per replica |
| Error rate | Failed requests divided by attempted requests | Reliability of the tested configuration |

For each RPS row, report the requested rate, completed rate, successful request count, actual duration, mean input/output tokens, TTFT, ITL, E2E latency, output token throughput, and errors. Distinguish the requested rate from the completed rate: a service can receive 5 RPS while completing only 2 RPS.

## Record Reproducible Metadata

Store raw benchmark output together with a metadata object similar to the following. Use a UUID for every experiment and keep timestamps in UTC.

```json
{
  "experiment_id": "<uuid-v4>",
  "experiment_type": "performance",
  "model": "<model-name-or-registry-reference>",
  "inference_server": "<runtime-name>",
  "inference_server_version": "<runtime-version>",
  "container_image": "<image-reference>",
  "container_image_tag": "<immutable-tag-or-digest>",
  "container_entrypoint": "<full-start-command>",
  "inference_server_args": {
    "tensor_parallel_size": 1,
    "max_model_len": 16384
  },
  "accelerator_type": "<accelerator>",
  "accelerator_count": 1,
  "accelerator_memory_gb": 80,
  "machine_type": "<machine-type>",
  "provider": "<cloud-or-on-prem>",
  "workload": {
    "name": "chat",
    "input_tokens": 512,
    "output_tokens": 256,
    "rates_rps": [1, 2, 3, 4, 5, 6, 7, 8, 9],
    "duration_seconds": 300
  },
  "report": "<raw GuideLLM JSON object or an embedded object>",
  "timestamp": "<RFC-3339 UTC timestamp>"
}
```

Record the exact model revision or digest, not only a mutable model name. Also record tokenizer revision, sampling parameters, replica count, tensor/pipeline parallel settings, request timeout, and whether TLS verification or an API gateway was used.

## Interpret and Validate Results

Plot each metric against offered RPS and inspect the complete curve. Typical behavior is low latency at light load, followed by queueing, rising TTFT/E2E, and a gap between offered and completed RPS near saturation. A single rate cannot establish capacity.

Apply these sanity checks before publishing a result:

- Confirm that all expected rates have a raw output and that the duration is not shortened by early stopping.
- Confirm that successful requests plus failed requests account for all attempted requests.
- Check that completed RPS does not exceed the number of attempted requests divided by the measured duration.
- Compare repeated runs at the same configuration; investigate large variance before drawing a conclusion.
- Check monotonicity across hardware and configurations. A more capable accelerator would normally reduce latency or increase throughput under the same workload. A violation is a signal to investigate placement, throttling, batching, tokenizer, or measurement errors; it is not evidence to silently discard inconvenient data.
- Keep separate results for different runtimes, quantization formats, model revisions, and topology. Do not combine them into one chart without labels.

The output is a performance observation, not a universal guarantee. State the tested workload, hardware, software, and load shape whenever the result is quoted.

## Troubleshooting

### The endpoint returns errors before the benchmark starts

Run the single-request Python check again and verify the model name, TLS
certificate, and endpoint path. If the Service requires an authorization proxy,
configure it in the Python backend settings and record that fact. Do not increase
the load until one request succeeds reliably.

### TTFT or ITL is unexpectedly high

Check for queueing by comparing requested and completed RPS, then inspect model-server logs and accelerator utilization. Confirm that the client is not sharing the inference node and that the model was warmed up. Repeat the lightest RPS first; if latency is already high at RPS 1, the issue is not caused by saturation at higher rates.

### Results differ between runs

Pin the model and container by digest, use the same tokenizer and sampling parameters, keep the workload and duration fixed, and run on the same accelerator topology. Check autoscaling and background traffic. Preserve every raw output so that aggregation or rounding cannot hide the variance.

### The Python API rejects a scenario

Check the installed GuideLLM version and compare the scenario fields with that
version's Python schemas. Package upgrades can rename fields or change defaults.
Run a short smoke benchmark before starting the full sweep, and do not combine
reports generated by incompatible package versions.

## Glossary

- **E2E latency**: Total time from request submission to the final generated token.
- **ITL**: Inter-token latency after the first token is emitted.
- **TTFT**: Time to first token.
- **RPS**: Requests per second offered to the endpoint.
- **Open-loop test**: Requests arrive according to a configured rate, independent of previous completions.
- **Throughput**: The amount of work completed per unit time, commonly reported as requests per second or output tokens per second.
