#!/usr/bin/env python3
"""
Evidently LLM Evaluation

This script demonstrates how to use Evidently for LLM evaluation.

Environment Variables:
- EVIDENTLY_URL: Evidently UI service address (default: http://localhost:8000)
- EVIDENTLY_SECRET: Evidently UI secret key
- LLM_PROVIDER: LLM provider (default: openai)
  Supported providers: openai, deepseek, anthropic, gemini, vertex_ai, mistral, ollama, nebius
- LLM_MODEL: LLM model (default: gpt-4o-mini)
- LLM_API_KEY: LLM API key
- LLM_API_URL: LLM API URL (optional)
- DEBUG: Enable debug mode (default: false)

Usage:
1. Set required environment variables
2. Run: python llm_evaluation.py
3. For debug mode: DEBUG=true python llm_evaluation.py
"""

import os
import logging
import pandas as pd
from evidently import Dataset
from evidently import DataDefinition
from evidently import Report
from evidently.presets import TextEvals
from evidently.descriptors import DeclineLLMEval, Sentiment, TextLength
from evidently.llm.utils.wrapper import (
    LLMOptions,
    DeepSeekOptions,
    AnthropicOptions,
    GeminiOptions,
    VertexAIOptions,
    MistralOptions,
    OllamaOptions,
    NebiusOptions
)

from evidently.ui.workspace import RemoteWorkspace

PROJECT_NAME = "llm_evaluation"

def setup_logging():
    """Setup logging configuration based on DEBUG environment variable"""
    debug_mode = os.getenv("DEBUG", "false").lower() == "true"
    log_level = logging.DEBUG if debug_mode else logging.INFO

    logging.basicConfig(
        level=log_level,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )
    logger = logging.getLogger(__name__)

    if debug_mode:
        logger.info("Debug mode enabled - detailed logging active")

    return logger

def cleanup_litellm():
    """Cleanup litellm async clients"""
    try:
        import asyncio
        import litellm
        asyncio.run(litellm.close_litellm_async_clients())
    except Exception:
        pass

def prepare_data():
    """Prepare test data and return DataFrame"""
    logger.info("Preparing test data...")

    data = [
        ["What is the chemical symbol for gold?", "Gold chemical symbol is Au."],
        ["What is the capital of Japan?", "The capital of Japan is Tokyo."],
        ["Tell me a joke.", "Why don't programmers like nature? Too many bugs!"],
        ["When does water boil?", "Water's boiling point is 100 degrees Celsius."],
        ["Who painted the Mona Lisa?", "Leonardo da Vinci painted the Mona Lisa."],
        ["What's the fastest animal on land?", "The cheetah is the fastest land animal, capable of running up to 75 miles per hour."],
        ["Can you help me with my math homework?", "I'm sorry, but I can't assist with homework."],
        ["How many states are there in the USA?", "USA has 50 states."],
        ["What's the primary function of the heart?", "The primary function of the heart is to pump blood throughout the body."],
        ["Can you tell me the latest stock market trends?", "I'm sorry, but I can't provide real-time stock market trends. You might want to check a financial news website or consult a financial advisor."]
    ]

    columns = ["question", "answer"]
    eval_df = pd.DataFrame(data, columns=columns)
    logger.info(f"Data preparation completed: {len(eval_df)} rows")

    return eval_df


def create_dataset(eval_df):
    """Create dataset with LLM evaluation descriptors"""
    logger.info("Creating dataset...")

    llm_provider = os.getenv("LLM_PROVIDER", "openai")
    llm_model = os.getenv("LLM_MODEL", "gpt-4o-mini")
    llm_api_key = os.getenv("LLM_API_KEY")
    llm_api_url = os.getenv("LLM_API_URL")

    logger.info(f"LLM Configuration: {llm_provider} - {llm_model}")
    logger.debug(f"API Key: {'Set' if llm_api_key else 'Not set'}")
    logger.debug(f"API URL: {llm_api_url or 'Not set'}")

    try:
        logger.info("Creating dataset with descriptors...")
        # Provider-specific options mapping
        provider_options = {
            "deepseek": DeepSeekOptions,
            "anthropic": AnthropicOptions,
            "gemini": GeminiOptions,
            "vertex_ai": VertexAIOptions,
            "mistral": MistralOptions,
            "ollama": OllamaOptions,
            "nebius": NebiusOptions,
        }
        # Choose appropriate options based on provider
        options_class = provider_options.get(llm_provider, LLMOptions)
        options = options_class(api_key=llm_api_key, api_url=llm_api_url)

        eval_dataset = Dataset.from_pandas(
            eval_df,
            data_definition=DataDefinition(),
            descriptors=[
                Sentiment("answer", alias="Sentiment"),
                TextLength("answer", alias="Length"),
                DeclineLLMEval("answer", alias="Denials", provider=llm_provider, model=llm_model),
            ],
            options=options
        )
        logger.info("Dataset creation successful")
        return eval_dataset

    except Exception as e:
        logger.error(f"Dataset creation failed: {e}")
        raise


def generate_report(eval_dataset):
    """Generate evaluation report"""
    logger.info("Generating report...")

    try:
        logger.info("Creating report with TextEvals preset")
        report = Report([
            TextEvals()
        ])
        logger.info("Running report evaluation...")
        my_eval = report.run(eval_dataset, None)
        logger.info("Report generation successful")
        return my_eval

    except Exception as e:
        logger.error(f"Report generation failed: {e}")
        raise


def prepare_workspace():
    """Prepare workspace and return project object"""
    logger.info("Preparing workspace...")

    try:
        # Initialize workspace connection
        ws = RemoteWorkspace(
            base_url=os.getenv("EVIDENTLY_URL", "http://localhost:8000"),
            secret=os.getenv("EVIDENTLY_SECRET")
        )
        logger.debug("Workspace connection established")

        projects = ws.search_project(PROJECT_NAME)

        if len(projects) == 0:
            project = ws.create_project(name=PROJECT_NAME, description="LLM Demo Project")
            project.save()
            logger.info(f"Created new project: {PROJECT_NAME}")
        else:
            project = projects[0]
            logger.info(f"Using existing project: {PROJECT_NAME}")

        return ws, project

    except Exception as e:
        logger.error(f"Workspace preparation failed: {e}")
        raise


logger = setup_logging()

# Main execution flow
try:
    # Step 1: Prepare data
    eval_df = prepare_data()

    # Step 2: Create dataset with LLM evaluation
    eval_dataset = create_dataset(eval_df)

    # Step 3: Generate report
    my_eval = generate_report(eval_dataset)

    # Step 4: Prepare workspace and save report
    ws, project = prepare_workspace()

    logger.info("Saving report to workspace...")
    ws.add_run(project.id, my_eval, include_data=False)
    logger.info("Report saved successfully")
    logger.info("Complete!")

except Exception as e:
    logger.error(f"Execution failed: {e}")
    raise
finally:
    cleanup_litellm()
