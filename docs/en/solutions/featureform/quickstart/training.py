import featureform as ff
import os

variant = os.getenv("FEATUREFORM_VARIANT", "demo")

client = ff.Client(host=os.getenv("FEATUREFORM_HOST", "localhost:7878"), insecure=True)

# reference: https://sdk.featureform.com/register/#featureform.register.ResourceClient
dataset = client.get_training_set("fraud_training", variant)

# training loop
for i, data in enumerate(dataset):
    # training data
    print(data)
    # training process
    # do the training here
    if i > 25:
        break

client.close()
