import featureform as ff
import os

variant = os.getenv("FEATUREFORM_VARIANT", "demo")
client = ff.Client(host=os.getenv("FEATUREFORM_HOST", "localhost:7878"), insecure=True)

customer_feat = client.features(
    features=[("avg_transactions", variant)],
    entities={"customer": "C1214240"},
)

print("Customer Result: ")
print(customer_feat)

client.close()
