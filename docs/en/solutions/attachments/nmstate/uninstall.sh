#!/usr/bin/env bash

set -euo pipefail

echo "Uninstalling NMState..."

# Delete NMState deployment
kubectl delete deployment nmstate-operator -n nmstate --ignore-not-found=true

# Delete NMState namespace and all resources in it
kubectl delete namespace nmstate --ignore-not-found=true

# Delete NMState CRD
kubectl delete crd nmstates.nmstate.io --ignore-not-found=true

# Delete any remaining NMState instances
kubectl delete nmstates --all --all-namespaces --ignore-not-found=true

echo "NMState uninstallation completed!"
