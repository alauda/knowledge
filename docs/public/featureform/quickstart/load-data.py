#!/usr/bin/env python3
"""
Prepare script for Featureform quickstart demo.
This script connects to PostgreSQL and executes the data.sql file to set up the demo database.
"""
import os
import sys
import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT
import logging

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def create_database_if_not_exists(host, port, user, password, database_name):
    """Create database if it doesn't exist"""
    try:
        # Connect to default postgres database to create target database
        conn = psycopg2.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            database="postgres"  # Connect to default database
        )
        conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cursor = conn.cursor()
        # Check if database exists
        cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", (database_name,))
        exists = cursor.fetchone()
        if not exists:
            logger.info(f"Creating database: {database_name}")
            cursor.execute(f'CREATE DATABASE "{database_name}"')
            logger.info(f"Database {database_name} created successfully")
        else:
            logger.info(f"Database {database_name} already exists")
        cursor.close()
        conn.close()
    except Exception as e:
        logger.error(f"Failed to create database: {e}")
        raise

def execute_sql_file(host, port, user, password, database):
    """Execute SQL file"""
    try:
        # Try to connect to target database
        try:
            conn = psycopg2.connect(
                host=host,
                port=port,
                user=user,
                password=password,
                database=database
            )
            logger.info(f"Successfully connected to database: {database}")
        except psycopg2.OperationalError as e:
            if "does not exist" in str(e):
                logger.info(f"Database {database} does not exist, creating...")
                create_database_if_not_exists(host, port, user, password, database)
                # Reconnect
                conn = psycopg2.connect(
                    host=host,
                    port=port,
                    user=user,
                    password=password,
                    database=database
                )
                logger.info(f"Database {database} created successfully, reconnected")
            else:
                raise
        cursor = conn.cursor()
        # Read SQL file
        sql_file_path = os.path.join(os.path.dirname(__file__), "data.sql")
        logger.info(f"Reading SQL file: {sql_file_path}")
        with open(sql_file_path, 'r', encoding='utf-8') as f:
            sql_content = f.read()
        # Split SQL statements (by semicolon, but ignore semicolons in strings)
        sql_statements = []
        current_statement = ""
        in_string = False
        string_char = None
        for char in sql_content:
            if char in ["'", '"'] and (not in_string or char == string_char):
                if not in_string:
                    in_string = True
                    string_char = char
                else:
                    in_string = False
                    string_char = None
            current_statement += char
            if char == ';' and not in_string:
                sql_statements.append(current_statement.strip())
                current_statement = ""
        # Add last statement (if no semicolon at end)
        if current_statement.strip():
            sql_statements.append(current_statement.strip())
        logger.info(f"Found {len(sql_statements)} SQL statements")
        # Execute each SQL statement
        for i, statement in enumerate(sql_statements):
            statement = statement.strip()
            if not statement or statement.startswith('--') or statement.startswith('\\'):
                continue
            try:
                logger.info(f"Executing SQL statement {i+1}...")
                cursor.execute(statement)
                logger.info(f"SQL statement {i+1} executed successfully")
            except Exception as e:
                logger.warning(f"SQL statement {i+1} failed: {e}")
                # Continue with next statement
        # Commit transaction
        conn.commit()
        logger.info("All SQL statements executed successfully")
        cursor.close()
        conn.close()
    except Exception as e:
        logger.error(f"Failed to execute SQL file: {e}")
        raise

def main():
    """Main function"""
    try:
        logger.info("Starting Featureform demo database preparation...")
        # Get database connection info
        host = os.getenv("POSTGRES_HOST", "localhost")
        port = os.getenv("POSTGRES_PORT", "5432")
        user = os.getenv("POSTGRES_USER", "postgres")
        password = os.getenv("POSTGRES_PASSWORD", "password")
        database = os.getenv("POSTGRES_DATABASE", "postgres")
        # Try to execute SQL file directly, create database if it doesn't exist
        execute_sql_file(host, port, user, password, database)
        logger.info("Database preparation completed!")
        logger.info("Now you can run 'python definitions.py' to register Featureform resources")
    except Exception as e:
        logger.error(f"Database preparation failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
