#!/usr/bin/env python3
"""
Evidently Data and ML Checks

This script demonstrates how to use Evidently for data drift detection and ML model monitoring.

Environment Variables:
- EVIDENTLY_URL: Evidently UI service address (default: http://localhost:8000)
- EVIDENTLY_SECRET: Evidently UI secret key
- DEBUG: Enable debug mode (default: false)

Usage:
1. Set required environment variables
2. Run: python data_and_ml_checks.py
3. For debug mode: DEBUG=true python data_and_ml_checks.py
"""

import os
import logging
import pandas as pd
from sklearn import datasets
from evidently import Dataset
from evidently import DataDefinition
from evidently import Report
from evidently.presets import DataDriftPreset
from evidently.ui.workspace import RemoteWorkspace

PROJECT_NAME = "data_and_ml_checks"

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



def prepare_data():
    """Prepare reference and production datasets"""
    logger.info("Loading adult dataset...")
    adult_data = datasets.fetch_openml(name="adult", version=2, as_frame="auto")
    adult = adult_data.frame
    adult_ref = adult[~adult.education.isin(["Some-college", "HS-grad", "Bachelors"])]
    adult_prod = adult[adult.education.isin(["Some-college", "HS-grad", "Bachelors"])]

    logger.info(f"Reference dataset: {len(adult_ref)} rows")
    logger.info(f"Production dataset: {len(adult_prod)} rows")

    return adult_ref, adult_prod


def create_datasets(adult_ref, adult_prod):
    """Create reference and production datasets"""
    logger.info("Creating datasets...")

    try:
        schema = DataDefinition(
            numerical_columns=["education-num", "age", "capital-gain", "hours-per-week", "capital-loss", "fnlwgt"],
            categorical_columns=["education", "occupation", "native-country", "workclass", "marital-status", "relationship", "race", "sex", "class"],
        )

        ref_dataset = Dataset.from_pandas(
            pd.DataFrame(adult_ref),
            data_definition=schema
        )

        prod_dataset = Dataset.from_pandas(
            pd.DataFrame(adult_prod),
            data_definition=schema
        )

        logger.info("Datasets created successfully")
        return ref_dataset, prod_dataset

    except Exception as e:
        logger.error(f"Dataset creation failed: {e}")
        raise


def generate_report(ref_dataset, prod_dataset):
    """Generate data drift report"""
    logger.info("Generating data drift report...")

    try:
        logger.info("Creating report with DataDriftPreset preset")
        report = Report([
            DataDriftPreset()
        ])
        logger.info("Running report evaluation...")
        my_eval = report.run(ref_dataset, prod_dataset)
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
            project = ws.create_project(name=PROJECT_NAME, description="Data and ML Checks Project")
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
    adult_ref, adult_prod = prepare_data()

    # Step 2: Create datasets
    ref_dataset, prod_dataset = create_datasets(adult_ref, adult_prod)

    # Step 3: Generate report
    my_eval = generate_report(ref_dataset, prod_dataset)

    # Step 4: Prepare workspace and save report
    ws, project = prepare_workspace()

    logger.info("Saving report to workspace...")
    ws.add_run(project.id, my_eval, include_data=False)
    logger.info("Report saved successfully")
    logger.info("Complete!")

except Exception as e:
    logger.error(f"Execution failed: {e}")
    raise