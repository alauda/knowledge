#!/bin/bash

# set whether to get equivalent variants, default is true, here set to false to avoid getting wrong variant
export FF_GET_EQUIVALENT_VARIANTS=false

# set featureform access
# set variant for demo
export FEATUREFORM_HOST=localhost:7878
export FEATUREFORM_VARIANT=demo

# set postgres access info
export POSTGRES_PORT=5432
export POSTGRES_USER=postgres
export POSTGRES_PASSWORD=password
export POSTGRES_DATABASE=postgres
# sslmode options: require, disable, verify-full, verify-ca
export POSTGRES_SSLMODE=require

# set redis access info
export REDIS_HOST=localhost
export REDIS_PORT=6379
export REDIS_PASSWORD=""