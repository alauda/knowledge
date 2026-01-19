---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
---
# Evaluating Large Language Models with lm-evaluation-harness

## Overview

The **lm-evaluation-harness** (lm-eval) is a unified framework developed by EleutherAI for testing generative language models on a large number of evaluation tasks. It provides a standardized way to measure and compare LLM performance across different benchmarks.

### Key Features

- **60+ Standard Academic Benchmarks**: Includes hundreds of subtasks and variants for comprehensive evaluation
- **Multiple Model Backends**: Support for HuggingFace Transformers, vLLM, API-based models (OpenAI, Anthropic), and local inference servers
- **Flexible Task Types**: Supports various evaluation methods including:
  - `generate_until`: Generation tasks with stopping criteria
  - `loglikelihood`: Log-likelihood evaluation for classification
  - `loglikelihood_rolling`: Perplexity evaluation
  - `multiple_choice`: Multiple-choice question answering
- **Reproducible Evaluations**: Public prompts ensure reproducibility and comparability
- **API Support**: Evaluate models via OpenAI-compatible APIs, Anthropic, and custom endpoints
- **Optimized Performance**: Data-parallel evaluation, vLLM acceleration, and automatic batch sizing

### Common Use Cases

lm-evaluation-harness is particularly valuable for:

- **Model Development**: Benchmark base models and track performance across training checkpoints
- **Fine-tuning Validation**: Compare fine-tuned models against base models to measure improvement or regression
- **Model Compression**: Evaluate quantized, pruned, or distilled models to assess the performance-efficiency tradeoff
- **Model Selection**: Compare different models on the same benchmarks to select the best fit for your use case
- **Reproducible Research**: Ensure consistent evaluation methodology across experiments and publications

The framework is used by Hugging Face's Open LLM Leaderboard, referenced in hundreds of research papers, and adopted by organizations including NVIDIA, Cohere, and Mosaic ML.

## Quickstart

### Installation

Install the base package:

```bash
pip install lm-eval
```

For API-based evaluation (recommended for production model services):

```bash
pip install "lm_eval[api]"
```

### Basic Usage

#### 1. List Available Tasks

```bash
lm-eval ls tasks
```

#### 2. Evaluate via OpenAI-Compatible API

This is the recommended approach for evaluating model services deployed with OpenAI-compatible APIs.

**Example** (evaluate a local model service):

```bash
lm-eval --model local-chat-completions \
    --model_args model=Qwen/Qwen2.5-7B-Instruct,base_url=http://localhost:8000/v1 \
    --tasks gsm8k,arc_easy,hellaswag \
    --batch_size 8 \
    --output_path ./results
```

**Key Parameters**:
- `--model`: Use `local-chat-completions` for local API servers, `openai-chat-completions` for OpenAI
- `--model_args`:
  - `model`: Model name or identifier
  - `base_url`: API endpoint (for local services only)
  - `api_key`: API key if required (can also use environment variable)
  - `tokenizer` (optional): Path to tokenizer for accurate token counting
  - `tokenized_requests` (optional): Whether to use local tokenization (default: False)
- `--tasks`: Comma-separated list of evaluation tasks
- `--batch_size`: Number of requests to process in parallel (adjust based on API rate limits)
- `--output_path`: Directory to save evaluation results

**About Tokenization**:

lm-eval supports two tokenization modes via the `tokenized_requests` parameter:

- **`tokenized_requests=False` (default)**: Text is sent to the API server, which handles tokenization. Simpler setup, suitable for `generate_until` tasks.
- **`tokenized_requests=True`**: lm-eval tokenizes text locally and sends token IDs to the API. Required for tasks needing token-level log probabilities.

**Task-specific requirements**:

- **`generate_until` tasks** (GSM8K, HumanEval, MATH, DROP, SQuAD, etc.):
  - Work with `tokenized_requests=False` (server-side tokenization)
  - No logprobs needed
  - ✅ Fully supported with chat APIs

- **`multiple_choice` tasks** (MMLU, ARC, HellaSwag, PIQA, etc.):
  - Internally use `loglikelihood` to score each choice
  - Work with `tokenized_requests=False` but less accurate
  - ⚠️ Work better with logprobs support (not available in most chat APIs)

- **`loglikelihood` / `loglikelihood_rolling` tasks** (LAMBADA, perplexity evaluation):
  - Require `tokenized_requests=True` + token-level log probabilities from API
  - ❌ Not supported by most chat APIs (OpenAI ChatCompletions, etc.)
  - Use local models (HuggingFace, vLLM) for these tasks

**Optional tokenizer configuration** (for accurate token counting or local tokenization):

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=http://localhost:8000/v1,tokenizer=MODEL_NAME,tokenized_requests=False \
    --tasks gsm8k
```

Available tokenization parameters in `model_args`:
- `tokenizer`: Path or name of the tokenizer (e.g., HuggingFace model name)
- `tokenizer_backend`: Tokenization system - `"huggingface"` (default), `"tiktoken"`, or `"none"`
- `tokenized_requests`: `True` (client-side) or `False` (server-side, default)

### Advanced Options

#### Save Results and Sample Responses

Enable `--log_samples` to save individual model responses for detailed analysis:

```bash
lm-eval --model local-chat-completions \
    --model_args model=Qwen/Qwen2.5-7B-Instruct,base_url=http://localhost:8000/v1 \
    --tasks gsm8k,hellaswag \
    --output_path ./results \
    --log_samples
```

This creates a `results/` directory containing:
- `results.json`: Overall evaluation metrics
- `*_eval_samples.json`: Individual samples with model predictions and references

#### Use Configuration File

For complex evaluations, use a YAML configuration file:

```yaml
model: local-chat-completions
model_args:
  model: Qwen/Qwen2.5-7B-Instruct
  base_url: http://localhost:8000/v1
tasks:
  - mmlu
  - gsm8k
  - arc_easy
  - arc_challenge
  - hellaswag
batch_size: 8
output_path: ./results
log_samples: true
```

Run with config:

```bash
lm-eval --config config.yaml
```

#### Quick Testing with Limited Examples

Test your setup with a small number of examples before running full evaluations:

```bash
lm-eval --model local-chat-completions \
    --model_args model=Qwen/Qwen2.5-7B-Instruct,base_url=http://localhost:8000/v1 \
    --tasks mmlu \
    --limit 10
```

#### Compare Multiple Models

Evaluate multiple model endpoints by running separate evaluations:

```bash
# Evaluate base model
lm-eval --model local-chat-completions \
    --model_args model=Qwen/Qwen2.5-7B,base_url=http://localhost:8000/v1 \
    --tasks gsm8k,mmlu \
    --output_path ./results/base_model

# Evaluate fine-tuned model
lm-eval --model local-chat-completions \
    --model_args model=Qwen/Qwen2.5-7B-finetuned,base_url=http://localhost:8001/v1 \
    --tasks gsm8k,mmlu \
    --output_path ./results/finetuned_model
```

**Note**: lm-eval outputs separate `results.json` files for each evaluation. To compare results, you need to read and analyze the JSON files manually. Here's a simple Python script to compare results:

```python
import json

# Load results
with open('./results/base_model/results.json') as f:
    base_results = json.load(f)['results']

with open('./results/finetuned_model/results.json') as f:
    finetuned_results = json.load(f)['results']

# Compare results
print("Model Comparison:")
print("-" * 60)
for task in base_results.keys():
    print(f"\n{task}:")
    for metric in base_results[task].keys():
        if not metric.endswith('_stderr'):
            base_score = base_results[task][metric]
            finetuned_score = finetuned_results[task][metric]
            diff = finetuned_score - base_score
            print(f"  {metric}:")
            print(f"    Base:      {base_score:.4f}")
            print(f"    Fine-tuned: {finetuned_score:.4f}")
            print(f"    Difference: {diff:+.4f}")
```

#### API-Specific Considerations

**Controlling Request Rate**: Adjust these parameters to match your API capacity:

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=API_URL,num_concurrent=1,max_retries=3,timeout=60 \
    --tasks gsm8k \
    --batch_size 1
```

**Available parameters in `model_args`**:
- `num_concurrent`: Number of concurrent requests. Typical values: 1 (sequential), 10, 50, or 128 depending on API capacity.
- `max_retries`: Number of retries for failed requests. Common values: 3, 5, or more.
- `timeout`: Request timeout in seconds. Adjust based on model size and API speed (e.g., 60, 300, or higher for large models).
- `batch_size`: Number of requests to batch together (set via `--batch_size` flag, not in `model_args`)

**Authentication**: Set API keys via environment variables or model_args:

```bash
# Via environment variable
export OPENAI_API_KEY=your_key

# Or via model_args
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=API_URL,api_key=YOUR_KEY \
    --tasks gsm8k
```

### Alternative Model Backends

While API-based evaluation is recommended for production services, lm-eval also supports:

- **HuggingFace Transformers** (`--model hf`): For local model evaluation with full access to logprobs
- **vLLM** (`--model vllm`): For optimized local inference with tensor parallelism
- Other backends: See the [official documentation](https://github.com/EleutherAI/lm-evaluation-harness/tree/main/docs) for details

## Datasets

lm-eval includes 60+ standard academic benchmarks. Below is a comprehensive overview of available datasets.

### Understanding Task Types

Before reviewing the datasets, it's important to understand the different task types:

- **`generate_until`**: Generate text until a stopping condition (e.g., newline, max tokens). Best for open-ended generation tasks. Works with both chat and completion APIs.
- **`multiple_choice`**: Select from multiple options. Can work with or without logprobs (more accurate with logprobs). Works with both chat and completion APIs.
- **`loglikelihood`**: Calculate token-level log probabilities. Requires API to return logprobs. Only works with completion APIs or local models.
- **`loglikelihood_rolling`**: Calculate perplexity over sequences. Requires logprobs. Only works with completion APIs or local models.

### Complete Dataset Reference

| Category | Dataset | Task Name | Task Type | Output Metrics | API Interface | Tokenization | Description |
|----------|---------|-----------|-----------|----------------|---------------|--------------|-------------|
| **General Knowledge** | MMLU | `mmlu_*` (57 subjects) | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | 57 subjects covering STEM, humanities, social sciences: abstract_algebra, anatomy, astronomy, business_ethics, clinical_knowledge, college_biology, college_chemistry, college_computer_science, college_mathematics, college_medicine, college_physics, computer_security, conceptual_physics, econometrics, electrical_engineering, elementary_mathematics, formal_logic, global_facts, high_school_biology, high_school_chemistry, high_school_computer_science, high_school_european_history, high_school_geography, high_school_government_and_politics, high_school_macroeconomics, high_school_mathematics, high_school_microeconomics, high_school_physics, high_school_psychology, high_school_statistics, high_school_us_history, high_school_world_history, human_aging, human_sexuality, international_law, jurisprudence, logical_fallacies, machine_learning, management, marketing, medical_genetics, miscellaneous, moral_disputes, moral_scenarios, nutrition, philosophy, prehistory, professional_accounting, professional_law, professional_medicine, professional_psychology, public_relations, security_studies, sociology, us_foreign_policy, virology, world_religions |
| | MMLU-Pro | `mmlu_pro` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Enhanced MMLU with 10 options per question and higher difficulty |
| | AGIEval | `agieval` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Academic exams including LSAT, SAT, GaoKao (Chinese & English) |
| | C-Eval | `ceval` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Chinese comprehensive evaluation across 52 subjects |
| **Instruction Following** | IFEval | `ifeval` | `generate_until` | `prompt_level_strict_acc`, `inst_level_strict_acc` | Chat / Completion | Server-side | Instruction following evaluation with verifiable constraints |
| **Commonsense Reasoning** | HellaSwag | `hellaswag` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Sentence completion with commonsense reasoning |
| | ARC | `arc_easy` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Easy grade-school science questions |
| | | `arc_challenge` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Challenging grade-school science questions |
| | WinoGrande | `winogrande` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Pronoun resolution reasoning |
| | OpenBookQA | `openbookqa` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Open book question answering |
| | CommonsenseQA | `commonsense_qa` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Commonsense question answering |
| | Social IQA | `social_iqa` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Social interaction question answering |
| **Mathematics** | GSM8K | `gsm8k` | `generate_until` | `exact_match` | Chat / Completion | Server-side | Grade-school math word problems |
| | | `gsm8k_cot` | `generate_until` | `exact_match` | Chat / Completion | Server-side | GSM8K with chain-of-thought prompting |
| | MATH | `minerva_math` | `generate_until` | `exact_match` | Chat / Completion | Server-side | Competition-level mathematics problems |
| | MathQA | `mathqa` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Math word problems with multiple choice |
| | MGSM | `mgsm_direct`, `mgsm_native_cot` | `generate_until` | `exact_match` | Chat / Completion | Server-side | Multilingual grade-school math (10 languages: Bengali, Chinese, French, German, Japanese, Russian, Spanish, Swahili, Telugu, Thai) |
| **Coding** | HumanEval | `humaneval` | `generate_until` | `pass@1`, `pass@10`, `pass@100` | Chat / Completion | Server-side | Python code generation from docstrings |
| | MBPP | `mbpp` | `generate_until` | `pass@1`, `pass@10`, `pass@100` | Chat / Completion | Server-side | Basic Python programming problems |
| **Reading Comprehension** | RACE | `race` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Reading comprehension from exams |
| | SQuAD | `squad_v2` | `generate_until` | `exact`, `f1`, `HasAns_exact`, `HasAns_f1` | Chat / Completion | Server-side | Extractive question answering |
| | DROP | `drop` | `generate_until` | `em`, `f1` | Chat / Completion | Server-side | Reading comprehension requiring discrete reasoning |
| **Language Understanding** | LAMBADA | `lambada_openai` | `loglikelihood` | `perplexity`, `acc` | ❌ Requires logprobs | Client-side | Word prediction in context |
| | PIQA | `piqa` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Physical interaction question answering |
| | LogiQA | `logiqa` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Logical reasoning questions |
| | COPA | `copa` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Causal reasoning |
| | StoryCloze | `storycloze_2016` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Story completion task |
| **Truthfulness & Safety** | TruthfulQA | `truthfulqa_mc1` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Single-correct answer truthfulness |
| | | `truthfulqa_mc2` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Multiple-correct answer truthfulness |
| | | `truthfulqa_gen` | `generate_until` | `bleu_max`, `rouge1_max`, `rougeL_max`, `bleurt_max` | Chat / Completion | Server-side | Generative truthfulness evaluation (also outputs _acc and _diff variants) |
| | BBQ | `bbq_*` (11 categories) | `multiple_choice` | `acc` | Chat / Completion | Server-side | Bias benchmark: age, disability, gender, nationality, physical_appearance, race_ethnicity, religion, ses (socio-economic status), sexual_orientation, race_x_gender (intersectional), race_x_ses (intersectional) |
| **Multilingual** | Belebele | `belebele_zho_Hans` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Chinese (Simplified) reading comprehension |
| | | `belebele_zho_Hant` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Chinese (Traditional) reading comprehension |
| | | `belebele_eng_Latn` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | English reading comprehension |
| | | `belebele_*` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | 122 languages total (see full list with `lm-eval ls tasks`) |
| | XCOPA | `xcopa_*` (11 languages) | `multiple_choice` | `acc` | Chat / Completion | Server-side | Causal reasoning: et (Estonian), ht (Haitian), id (Indonesian), it (Italian), qu (Quechua), sw (Swahili), ta (Tamil), th (Thai), tr (Turkish), vi (Vietnamese), zh (Chinese) |
| | XWinograd | `xwinograd_*` (6 languages) | `multiple_choice` | `acc` | Chat / Completion | Server-side | Winograd schema: en (English), fr (French), jp (Japanese), pt (Portuguese), ru (Russian), zh (Chinese) |
| **Factual Knowledge** | Natural Questions | `nq_open` | `generate_until` | `exact_match` | Chat / Completion | Server-side | Open-domain question answering |
| | TriviaQA | `triviaqa` | `generate_until` | `exact_match` | Chat / Completion | Server-side | Trivia question answering |
| | Web Questions | `webqs` | `multiple_choice` | `exact_match` | Chat / Completion | Server-side | Question answering from web search queries |
| **Summarization** | CNN/DailyMail | `cnn_dailymail` | `generate_until` | `rouge1`, `rouge2`, `rougeL` | Chat / Completion | Server-side | News article summarization |
| **Translation** | WMT | `wmt14`, `wmt16`, `wmt20` | `generate_until` | `bleu`, `chrf` | Chat / Completion | Server-side | Machine translation benchmarks (multiple language pairs) |
| **BIG-Bench** | BIG-Bench Hard (BBH) | `bbh_cot_fewshot` (23 tasks) | `generate_until` | `acc`, `exact_match` | Chat / Completion | Server-side | 23 challenging tasks: boolean_expressions, causal_judgement, date_understanding, disambiguation_qa, dyck_languages, formal_fallacies, geometric_shapes, hyperbaton, logical_deduction (3/5/7 objects), movie_recommendation, multistep_arithmetic_two, navigate, object_counting, penguins_in_a_table, reasoning_about_colored_objects, ruin_names, salient_translation_error_detection, snarks, sports_understanding, temporal_sequences, tracking_shuffled_objects (3/5/7 objects), web_of_lies, word_sorting |
| **Domain-Specific** | MedQA | `medqa` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Medical question answering from USMLE exams |
| | MedMCQA | `medmcqa` | `multiple_choice` | `acc`, `acc_norm` | Chat / Completion | Server-side | Medical multiple choice questions from Indian medical exams |
| | PubMedQA | `pubmedqa` | `multiple_choice` | `acc` | Chat / Completion | Server-side | Biomedical question answering from PubMed abstracts |

**Legend**:
- **Output Metrics**: These are the actual metric keys that appear in the output JSON (e.g., `acc`, `exact_match`, `pass@1`)
- **API Interface**:
  - `Chat / Completion`: Works with both OpenAI-compatible chat and completion APIs
  - `❌ Requires logprobs`: Only works with APIs that return token-level log probabilities, or local models
- **Tokenization**:
  - `Server-side`: Uses `tokenized_requests=False` (default). Text is sent to API server, which handles tokenization. Works for `generate_until` and `multiple_choice` tasks.
  - `Client-side`: Uses `tokenized_requests=True`. lm-eval tokenizes locally and sends token IDs. Required for `loglikelihood` tasks. Improves accuracy for `multiple_choice` tasks but requires logprobs support from API.

**Finding More Tasks**:
- Run `lm-eval ls tasks` to see all available tasks (60+ datasets with hundreds of variants)
- Many datasets have language-specific variants (e.g., `belebele_*`, `xcopa_*`)
- Task groups are available (e.g., `mmlu` runs all 57 MMLU subjects)

### Usage Examples

**Single task evaluation**:

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=http://localhost:8000/v1 \
    --tasks gsm8k \
    --output_path ./results
```

**Multiple tasks evaluation**:

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=http://localhost:8000/v1 \
    --tasks mmlu,gsm8k,arc_easy,arc_challenge,hellaswag \
    --output_path ./results
```

**Task group evaluation** (all MMLU subjects):

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=http://localhost:8000/v1 \
    --tasks mmlu \
    --output_path ./results
```

**Wildcard pattern** (specific MMLU subjects):

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=http://localhost:8000/v1 \
    --tasks "mmlu_mathematics,mmlu_physics,mmlu_chemistry" \
    --output_path ./results
```

**Multilingual evaluation** (Chinese Belebele):

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=http://localhost:8000/v1 \
    --tasks belebele_zho_Hans \
    --output_path ./results
```

### Common Task Combinations

**General LLM Benchmark Suite** (recommended for API evaluation):

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=http://localhost:8000/v1 \
    --tasks mmlu,gsm8k,arc_challenge,hellaswag,winogrande,truthfulqa_mc2 \
    --output_path ./results
```

**Math & Reasoning Suite**:

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=http://localhost:8000/v1 \
    --tasks gsm8k,math,arc_challenge \
    --output_path ./results
```

**Code Generation Suite**:

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=http://localhost:8000/v1 \
    --tasks humaneval,mbpp \
    --output_path ./results
```

**Open LLM Leaderboard Suite**:

```bash
lm-eval --model local-chat-completions \
    --model_args model=MODEL_NAME,base_url=http://localhost:8000/v1 \
    --tasks leaderboard \
    --output_path ./results
```

### Finding Tasks

**List all available tasks**:

```bash
lm-eval ls tasks
```

**Search for specific tasks**:

```bash
# Search for MMLU tasks
lm-eval ls tasks | grep mmlu

# Search for math-related tasks
lm-eval ls tasks | grep -i math

# Search for Chinese language tasks
lm-eval ls tasks | grep zho
```

**Task naming patterns**:
- Dataset groups: `mmlu`, `belebele` (runs all variants)
- Specific variants: `mmlu_mathematics`, `belebele_zho_Hans`
- Task variants: `gsm8k` vs `gsm8k_cot` (with/without chain-of-thought)

### Understanding Output Results

After running an evaluation, results are saved in JSON format. Here's what the key metrics mean:

**Common Metrics** (as they appear in `results.json`):

| Metric Key | Full Name | Description | Range | Higher is Better? |
|------------|-----------|-------------|-------|-------------------|
| `acc` | Accuracy | Proportion of correct answers | 0.0 - 1.0 | ✅ Yes |
| `acc_norm` | Normalized Accuracy | Accuracy using length-normalized probabilities | 0.0 - 1.0 | ✅ Yes |
| `exact_match` | Exact Match | Exact string match between prediction and reference | 0.0 - 1.0 | ✅ Yes |
| `exact` | Exact Match (SQuAD) | Exact match metric for SQuAD tasks | 0.0 - 100.0 | ✅ Yes |
| `em` | Exact Match (DROP) | Exact match metric for DROP task | 0.0 - 1.0 | ✅ Yes |
| `pass@1` | Pass at 1 | Percentage of problems solved on first attempt | 0.0 - 1.0 | ✅ Yes |
| `pass@10` | Pass at 10 | Percentage of problems solved in 10 attempts | 0.0 - 1.0 | ✅ Yes |
| `f1` | F1 Score | Harmonic mean of precision and recall | 0.0 - 1.0 | ✅ Yes |
| `bleu`, `bleu_max` | BLEU Score | Text similarity metric for generation/translation | 0.0 - 100.0 | ✅ Yes |
| `rouge1`, `rouge2`, `rougeL` | ROUGE Scores | Recall-oriented text similarity | 0.0 - 1.0 | ✅ Yes |
| `perplexity` | Perplexity | Model's uncertainty (lower is better) | > 0 | ❌ No (lower is better) |

**Example output structure**:

```json
{
  "results": {
    "mmlu": {
      "acc": 0.6234,
      "acc_norm": 0.6456,
      "acc_stderr": 0.0123,
      "acc_norm_stderr": 0.0115
    },
    "gsm8k": {
      "exact_match": 0.5621,
      "exact_match_stderr": 0.0142
    }
  },
  "versions": {
    "mmlu": 0,
    "gsm8k": 1
  },
  "config": {
    "model": "local-chat-completions",
    "model_args": "model=Qwen/Qwen2.5-7B-Instruct,base_url=http://localhost:8000/v1",
    "batch_size": 8
  }
}
```

**Notes**:
- `*_stderr`: Standard error of the metric (indicates confidence in the result)
- Multiple metrics per task: Some tasks report several metrics (e.g., both `acc` and `acc_norm`)
- Use the metric field names exactly as shown when referring to results in reports

### API Requirements by Task Type

| Task Type | Logprobs Required | Best Interface | Tokenization | Notes |
|-----------|------------------|----------------|--------------|-------|
| `generate_until` | No | Chat API | Server-side | Recommended for API evaluation. No local tokenizer needed. |
| `multiple_choice` | Recommended | Both | Server-side | Works with APIs but accuracy improves with logprobs |
| `loglikelihood` | Yes | Completion only | Client-side | Requires token-level probabilities. Not supported by most chat APIs. |
| `loglikelihood_rolling` | Yes | Completion only | Client-side | For perplexity evaluation. Not supported by most chat APIs. |

**Important Notes**:
- **For API-based evaluation**: Focus on `generate_until` tasks (GSM8K, ARC, MMLU, etc.). These don't require local tokenization or logprobs.
- **Tokenization**: With chat APIs, tokenization is handled server-side automatically. You only need to specify a local tokenizer if you want accurate token counting for cost estimation.
- **Logprobs limitation**: OpenAI ChatCompletions and most chat APIs don't provide token-level logprobs, making `loglikelihood` tasks unavailable. Use local models (HuggingFace, vLLM) if you need these task types.

## Additional Resources

### Official Documentation

- **GitHub Repository**: [https://github.com/EleutherAI/lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness)
- **Documentation**: [https://github.com/EleutherAI/lm-evaluation-harness/tree/main/docs](https://github.com/EleutherAI/lm-evaluation-harness/tree/main/docs)
- **Task Implementation Guide**: [https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/new_task_guide.md](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/new_task_guide.md)

### Example Notebook

Download the Jupyter notebook example: [lm-eval Quick Start Notebook](../public/lm-eval/lm-eval_quick_star.ipynb)

### Tips & Best Practices

1. **Start Small**: Use `--limit 10` to test your setup before running full evaluations
2. **Use Auto Batch Size**: Set `--batch_size auto` for optimal GPU utilization
3. **Save Results**: Always use `--output_path` and `--log_samples` for reproducibility
4. **Cache Results**: Use `--use_cache <DIR>` to resume interrupted evaluations
5. **Check Task Compatibility**: Verify your model supports the required output format (logprobs, generation, etc.)
6. **Monitor Resources**: Large evaluations can take hours; use tools like `htop` or `nvidia-smi` to monitor
7. **Validate First**: Use `lm-eval validate --tasks <task_name>` to check task configuration
