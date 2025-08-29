import featureform as ff
import os

variant = os.getenv("FEATUREFORM_VARIANT", "demo")

# Register a user profile and set it as the default owner for all resource definitions
# reference: https://sdk.featureform.com/register/#featureform.register.Registrar.register_user
ff.register_user("demo").make_default_owner()

# reference: https://sdk.featureform.com/providers/#postgres
postgres = ff.register_postgres(
    name=f"postgres-{variant}",
    description=f"Postgres for {variant}",
    host=os.getenv("POSTGRES_HOST", "localhost"),
    port=os.getenv("POSTGRES_PORT", "5432"),
    user=os.getenv("POSTGRES_USER", "postgres"),
    password=os.getenv("POSTGRES_PASSWORD", "password"),
    database=os.getenv("POSTGRES_DATABASE", "postgres"),
    sslmode=os.getenv("POSTGRES_SSLMODE", "require"),
)

# reference: https://sdk.featureform.com/providers/#redis
redis = ff.register_redis(
    name=f"redis-{variant}",
    description=f"Redis for {variant}",
    host=os.getenv("REDIS_HOST", "localhost"),
    port=int(os.getenv("REDIS_PORT", "6379")),
    password=os.getenv("REDIS_PASSWORD", ""),
)

# reference: https://sdk.featureform.com/register/#featureform.register.OfflineSQLProvider.register_table
transactions = postgres.register_table(
    name="transactions",
    description=f"Transactions table for fraud detection demo, variant: {variant}",
    table="transactions",
    variant=variant,
)

# Table: transactions
# columns:
#   transactionid       varchar
#   customerid          varchar
#   customerdob         varchar
#   custlocation        varchar
#   custaccountbalance  double
#   transactionamount   double
#   timestamp           timestamp
#   isfraud             boolean

# Define a SQL transformation to calculate the average transaction amount for each user
# reference: https://sdk.featureform.com/register/#featureform.register.OfflineSQLProvider.sql_transformation
@postgres.sql_transformation(variant=variant)
def average_user_transaction():
    return f"SELECT CustomerID as user_id, avg(TransactionAmount) " \
           f"as avg_transaction_amt from {{{{transactions.{variant}}}}} GROUP BY user_id" \
           f"-- for variant: {variant}"

# Define a Entity Customer
# reference: https://sdk.featureform.com/features/#registering-an-entity
@ff.entity
class Customer:
    # reference: https://sdk.featureform.com/features/#feature
    avg_transactions = ff.Feature(
        average_user_transaction[["user_id", "avg_transaction_amt"]],
        type=ff.Float32,
        inference_store=redis,
        variant=variant,
        description=f"Average transaction amount for variant {variant}",
    )
    # reference: https://sdk.featureform.com/features/#label
    fraudulent = ff.Label(
        transactions[["customerid", "isfraud"]],
        type=ff.Bool,
        variant=variant,
        description=f"Fraud label for variant {variant}",
    )

# Define a training set with the label and features
# reference: https://sdk.featureform.com/training_sets/
ff.register_training_set(
    name="fraud_training",
    description="Training set for fraud detection",
    label=("fraudulent", variant), # label name and variant
    features=[("avg_transactions", variant)], # feature name and variant
    variant=variant,
)

# Apply the definitions to the Featureform server
# reference: https://sdk.featureform.com/client_apply/
client = ff.Client(host=os.getenv("FEATUREFORM_HOST", "localhost:7878"), insecure=True)
client.apply()
