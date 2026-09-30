---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB260900055
---

# How to Deploy Elasticsearch and Kibana Using Elastic Cloud on Kubernetes (ECK)

## Overview

This guide walks you through deploying Elasticsearch and Kibana on Alauda Container Platform (ACP) with [Elastic Cloud on Kubernetes (ECK)](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s), the Kubernetes operator published by Elastic. You install ECK from Elastic's own YAML manifests, mirror Elastic's container images into a registry that your cluster can pull from, and then create an `Elasticsearch` and a `Kibana` resource.

**Verified versions** (verified on ACP 4.4 / Kubernetes 1.35, amd64; check the upstream documentation for newer releases):

| Component | Version |
| :--- | :--- |
| ECK operator | `3.4.1` |
| Elasticsearch | `9.5.4` |
| Kibana | `9.5.4` |

According to Elastic's [supported versions](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) page, ECK supports Kubernetes 1.31–1.36 and Elastic Stack 8.x and 9.x. This guide was verified with 9.5.4 only.

> **Note — licensing**
> ECK and the Elastic Stack container images are distributed by Elastic under Elastic's own license terms. This guide only points to Elastic's published manifests and images; it does not repackage them. Review Elastic's [licensing information](https://www.elastic.co/pricing/faq/licensing) before you use them.

For background, see:

- [ECK documentation](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)
- [ECK release notes](https://www.elastic.co/docs/release-notes/cloud-on-k8s)
- [Install ECK in an air-gapped environment](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install)

## Prerequisites

- An ACP 4.x cluster with `cluster-admin` access. ECK installs cluster-scoped objects (CRDs, ClusterRoles, and a `ValidatingWebhookConfiguration`).
- `kubectl` configured against the target cluster.
- A `StorageClass` with dynamic PVC provisioning.
- A private container registry that your cluster nodes can pull from, and credentials to push to it. On ACP you can use the platform registry (see Step 1).
- A workstation that can reach `download.elastic.co` and `docker.elastic.co`, with [`skopeo`](https://github.com/containers/skopeo) installed.

Export these variables once and reuse them throughout the guide:

```bash
export ECK_VERSION=3.4.1
export STACK_VERSION=9.5.4
export NS=<your-namespace>                # e.g. elastic-demo — where Elasticsearch and Kibana run
export ES_NAME=<your-cluster-name>        # e.g. quickstart — resources derive from it (<name>-es-http, <name>-es-elastic-user, ...)
export STORAGE_CLASS=<your-storageclass>  # e.g. a TopoLVM StorageClass
export REGISTRY_SERVER=<registry-host>    # host[:port] only, e.g. registry.example.com:11443
export PRIVATE_REGISTRY=<registry-host>/<project>   # host plus a project path, e.g. registry.example.com:11443/elastic
```

`REGISTRY_SERVER` is the registry **host** (used for credentials). `PRIVATE_REGISTRY` is the host **plus a project path** (used in image references). Keep them separate.

The ECK operator itself is installed into the `elastic-system` namespace, which is hardcoded in Elastic's `operator.yaml`.

## Step 1: Mirror the Required Images to Your Private Registry

ACP cluster nodes typically cannot pull from `docker.elastic.co`. Copy the three images into your registry.

> **Important — keep the repository paths**
> ECK builds the Elasticsearch and Kibana image names as `<registry>/elasticsearch/elasticsearch:<version>` and `<registry>/kibana/kibana:<version>`. Mirror the images under exactly these sub-paths below `$PRIVATE_REGISTRY`. Otherwise the operator's registry override in Step 3 will point to images that do not exist.

```bash
skopeo copy --all docker://docker.elastic.co/eck/eck-operator:${ECK_VERSION} \
  docker://${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}
skopeo copy --all docker://docker.elastic.co/elasticsearch/elasticsearch:${STACK_VERSION} \
  docker://${PRIVATE_REGISTRY}/elasticsearch/elasticsearch:${STACK_VERSION}
skopeo copy --all docker://docker.elastic.co/kibana/kibana:${STACK_VERSION} \
  docker://${PRIVATE_REGISTRY}/kibana/kibana:${STACK_VERSION}
```

`--all` copies every architecture in the upstream multi-arch index (amd64 and arm64), so the same mirror serves mixed-architecture clusters. The Elasticsearch image is large (about 0.9 GiB compressed per architecture), so allow enough time on slow links.

### Using the ACP platform registry

On ACP you can look up the platform registry address and the push credentials with `kubectl`:

```bash
# Registry host:port of the platform registry
kubectl -n kube-public get configmap global-info -o jsonpath='{.data.registryAddress}'; echo

# Push credentials (do not paste them into shared terminals or tickets)
REG_USER=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.username}' | base64 -d)
REG_PASS=$(kubectl -n cpaas-system get secret registry-admin -o jsonpath='{.data.password}' | base64 -d)
```

Set `REGISTRY_SERVER` to the address returned above and choose a project path for `PRIVATE_REGISTRY` (for example `${REGISTRY_SERVER}/elastic`). The platform registry uses a self-signed certificate, so add `--dest-creds` and `--dest-tls-verify=false` to each `skopeo copy`:

```bash
skopeo copy --all --dest-creds "${REG_USER}:${REG_PASS}" --dest-tls-verify=false \
  docker://docker.elastic.co/eck/eck-operator:${ECK_VERSION} \
  docker://${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}
# ...repeat for elasticsearch/elasticsearch and kibana/kibana as above
```

Confirm each mirrored digest matches the upstream one:

```bash
skopeo inspect --format '{{.Digest}}' docker://docker.elastic.co/eck/eck-operator:${ECK_VERSION}
skopeo inspect --tls-verify=false --creds "${REG_USER}:${REG_PASS}" --format '{{.Digest}}' \
  docker://${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}
```

## Step 2: Registry Credentials for Pulling (only if your registry requires login)

If your cluster nodes can pull from `$PRIVATE_REGISTRY` without credentials, skip this step. In the validation behind this guide, the nodes pulled the mirrored images anonymously, so no pull secret was used.

> **Not verified in this validation**
> The steps below follow Elastic's [air-gapped installation](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install) documentation. Alauda has not tested them on ACP.

If your registry requires login, create a pull secret in both the operator namespace and the workload namespace. Create the namespaces first if they do not exist yet.

```bash
for ns in elastic-system "$NS"; do
  kubectl -n "$ns" create secret docker-registry registry-pull \
    --docker-server="$REGISTRY_SERVER" \
    --docker-username="<registry-username>" \
    --docker-password="<registry-password>"
done
```

Then do the following:

- After Step 3, attach the secret to the operator:
  `kubectl -n elastic-system patch statefulset elastic-operator --type merge -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"registry-pull"}]}}}}'`
- In Step 5, add the secret to both custom resources. For the `Elasticsearch` resource, add `podTemplate.spec.imagePullSecrets` under each entry in `nodeSets`. For the `Kibana` resource, add `spec.podTemplate.spec.imagePullSecrets`:

  ```yaml
  podTemplate:
    spec:
      imagePullSecrets:
      - name: registry-pull
  ```

## Step 3: Install ECK

Download the pinned manifests from Elastic:

```bash
curl -fLO https://download.elastic.co/downloads/eck/${ECK_VERSION}/crds.yaml
curl -fLO https://download.elastic.co/downloads/eck/${ECK_VERSION}/operator.yaml
```

Rewrite `operator.yaml` in **two** places:

```bash
sed -e "s#docker.elastic.co/eck/eck-operator:${ECK_VERSION}#${PRIVATE_REGISTRY}/eck/eck-operator:${ECK_VERSION}#" \
    -e "s#container-registry: docker.elastic.co#container-registry: ${PRIVATE_REGISTRY}#" \
    operator.yaml > operator-mirrored.yaml

# Expect exactly these two changed lines
diff operator.yaml operator-mirrored.yaml
```

1. **The operator image** in the `elastic-operator` StatefulSet.
2. **`container-registry`** in the `eck.yaml` key of the `elastic-operator` ConfigMap. This is the operator's default registry for every Elastic Stack image it deploys (the configuration-file form of the `--container-registry` flag described in Elastic's air-gapped guide). After this change, ECK deploys `${PRIVATE_REGISTRY}/elasticsearch/elasticsearch:<version>` and `${PRIVATE_REGISTRY}/kibana/kibana:<version>` by itself. As a result, the `Elasticsearch` and `Kibana` resources in Step 5 need **no `spec.image` field**.

Install the CRDs, then the operator:

```bash
kubectl create -f crds.yaml
kubectl apply -f operator-mirrored.yaml
```

Wait for the operator to be ready:

```bash
kubectl -n elastic-system wait --for=condition=Ready pod/elastic-operator-0 --timeout=180s
kubectl -n elastic-system get pod elastic-operator-0
```

Expected output (the operator was ready about 15 seconds after `apply` in validation):

```text
NAME                 READY   STATUS    RESTARTS   AGE
elastic-operator-0   1/1     Running   0          20s
```

The operator runs the validating webhook itself. Confirm that the webhook Service has an endpoint:

```bash
kubectl -n elastic-system get endpointslice -l kubernetes.io/service-name=elastic-webhook-server
```

## Step 4: Namespace Pod Security

No Pod Security Admission labels were needed on ACP 4.4. By default ECK sets a restricted-compatible security context on the pods it creates. That context includes `seccompProfile: RuntimeDefault`, `runAsNonRoot`, `allowPrivilegeEscalation: false`, all capabilities dropped, and a read-only root filesystem on init containers. In validation, both `elastic-system` and the workload namespace were used without any `pod-security.kubernetes.io/*` labels, and every pod was admitted.

Create the workload namespace:

```bash
kubectl create namespace "$NS"
```

If your cluster enforces a stricter custom policy, inspect the rendered pods with `kubectl -n "$NS" get pod <pod> -o yaml` and adjust accordingly.

## Step 5: Create Elasticsearch and Kibana

### 5a. Elasticsearch

This single-node example follows Elastic's quickstart, with explicit persistent storage:

```bash
cat <<EOF | kubectl apply -f -
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: ${ES_NAME}
  namespace: ${NS}
spec:
  version: ${STACK_VERSION}
  nodeSets:
  - name: default
    count: 1
    config:
      node.store.allow_mmap: false
    volumeClaimTemplates:
    - metadata:
        name: elasticsearch-data   # keep this name; ECK mounts the data volume by it
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: ${STORAGE_CLASS}
        resources:
          requests:
            storage: 5Gi
EOF
```

`node.store.allow_mmap: false` comes from Elastic's quickstart. It avoids the need for `vm.max_map_count >= 262144` on the node. On the validation cluster the node already had `vm.max_map_count = 262144`, so this setting was not required there. For production, raise `vm.max_map_count` and remove the setting instead; see Elastic's [virtual memory](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/virtual-memory) page.

### 5b. Kibana

```bash
cat <<EOF | kubectl apply -f -
apiVersion: kibana.k8s.elastic.co/v1
kind: Kibana
metadata:
  name: ${ES_NAME}
  namespace: ${NS}
spec:
  version: ${STACK_VERSION}
  count: 1
  elasticsearchRef:
    name: ${ES_NAME}
EOF
```

### 5c. Wait for both to be ready

```bash
kubectl -n "$NS" get elasticsearch,kibana
```

Expected output once ready (about 2 minutes after the images became pullable in validation):

```text
NAME                                                    HEALTH   NODES   VERSION   PHASE   AGE
elasticsearch.elasticsearch.k8s.elastic.co/quickstart   green    1       9.5.4     Ready   3m

NAME                                      HEALTH   NODES   VERSION   AGE
kibana.kibana.k8s.elastic.co/quickstart   green    1       9.5.4     3m
```

The pods are `<name>-es-default-0` and `<name>-kb-<hash>`. The PVC is `elasticsearch-data-<name>-es-default-0`.

## Step 6: Verify Elasticsearch

ECK creates the `elastic` superuser and stores its password in the Secret `<name>-es-elastic-user`. Read it into a shell variable and do not print it:

```bash
PASSWORD=$(kubectl -n "$NS" get secret "${ES_NAME}-es-elastic-user" -o jsonpath='{.data.elastic}' | base64 -d)
ES_POD="${ES_NAME}-es-default-0"
ES_URL="https://${ES_NAME}-es-http:9200"
```

Query the cluster from inside the cluster. `-k` is used because ECK serves HTTPS with a self-signed CA by default.

```bash
kubectl -n "$NS" exec "$ES_POD" -c elasticsearch -- curl -sk -u "elastic:${PASSWORD}" "$ES_URL"
```

The response includes:

```text
  "cluster_name" : "quickstart",
    "number" : "9.5.4",
  "tagline" : "You Know, for Search"
```

Create a test index, index one document, and search for it. The index is created with `"number_of_replicas": 0` because a single-node cluster cannot place replica shards. With the default of 1 replica, the index, and therefore the cluster health, stays `yellow`.

```bash
kubectl -n "$NS" exec "$ES_POD" -c elasticsearch -- curl -sk -u "elastic:${PASSWORD}" \
  -XPUT "$ES_URL/demo-index" -H 'Content-Type: application/json' \
  -d '{"settings":{"number_of_replicas":0}}'

kubectl -n "$NS" exec "$ES_POD" -c elasticsearch -- curl -sk -u "elastic:${PASSWORD}" \
  -XPUT "$ES_URL/demo-index/_doc/1?refresh=true" -H 'Content-Type: application/json' \
  -d '{"msg":"hello from ACP"}'

kubectl -n "$NS" exec "$ES_POD" -c elasticsearch -- curl -sk -u "elastic:${PASSWORD}" \
  "$ES_URL/demo-index/_search?q=msg:hello&filter_path=hits.total"
```

Expected search result:

```json
{"hits":{"total":{"value":1,"relation":"eq"}}}
```

Clear the variable when you are done: `unset PASSWORD`.

## Uninstall

Remove everything in this order. The operator must still be running while the `Elasticsearch` and `Kibana` resources are deleted.

```bash
# 1. The Elastic Stack resources
kubectl -n "$NS" delete kibana "$ES_NAME"
kubectl -n "$NS" delete elasticsearch "$ES_NAME"
kubectl -n "$NS" get pod        # wait until the Elasticsearch and Kibana pods are gone

# 2. The data volumes (this permanently deletes the Elasticsearch data;
#    --all assumes $NS is dedicated to this deployment, as in this guide)
kubectl -n "$NS" get pvc
kubectl -n "$NS" delete pvc --all

# 3. The workload namespace
kubectl delete namespace "$NS"

# 4. Before removing the operator, confirm that no other namespace still uses ECK
for r in $(kubectl get crd -o name | grep k8s.elastic.co | cut -d/ -f2); do kubectl get "$r" -A --no-headers; done

# 5. The operator (also removes the elastic-system namespace, ClusterRoles and the webhook), then the CRDs
kubectl delete -f operator-mirrored.yaml
kubectl delete -f crds.yaml
```

Confirm that nothing is left:

```bash
kubectl get namespace "$NS" elastic-system      # both: NotFound
kubectl get crd | grep -c k8s.elastic.co        # 0
```

Finally, delete the mirrored images from your registry if you no longer need them.

See also Elastic's [uninstall guide](https://www.elastic.co/docs/deploy-manage/uninstall/uninstall-elastic-cloud-on-kubernetes).

## Limitations

- **Verified by Alauda:** the baseline in this guide was verified end-to-end on ACP 4.4 / Kubernetes 1.35 (amd64) on 2026-09-30. The run covered mirroring into the platform registry, the two `operator.yaml` rewrites, and the operator with its webhook reaching Ready. It also covered a single-node Elasticsearch 9.5.4 on a TopoLVM StorageClass and Kibana 9.5.4, both reaching `green`, the in-cluster HTTPS query, an index-and-search round trip, and the uninstall sequence above.
- **Not verified by Alauda:** these may work but have not been tested on ACP. Treat Elastic's documentation as authoritative and validate them in your own environment.

### Verified by Alauda

| Area | Result |
| :--- | :--- |
| ECK 3.4.1 install from mirrored images (CRDs + operator, webhook) | Operator Running, webhook endpoint ready |
| Registry override via `container-registry` (no `spec.image` in CRs) | Pods pulled the mirrored Elasticsearch and Kibana images |
| Pod Security | Admitted without namespace labels |
| Single-node Elasticsearch 9.5.4 with a PVC on TopoLVM | `green` / `Ready` |
| Kibana 9.5.4 connected through `elasticsearchRef` | `green` |
| In-cluster HTTPS access as `elastic`, index + search | Search returned 1 hit |
| Uninstall (CRs → PVCs → namespace → operator → CRDs) | No ECK objects, namespaces, or volumes left |

### Not verified by Alauda

| Area | Upstream reference |
| :--- | :--- |
| Registries that require a pull secret (Step 2) | [Air-gapped install](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install) |
| Multi-node / production-sized Elasticsearch topologies | [ECK documentation](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) |
| Access to Kibana or Elasticsearch from outside the cluster (Service type, Ingress) | [ECK documentation](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) |
| arm64 and mixed-architecture clusters | [ECK documentation](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) |
| Ceph RBD or other StorageClasses | — |
| ECK operator upgrades and Elastic Stack version upgrades | [Upgrade ECK](https://www.elastic.co/docs/deploy-manage/upgrade/orchestrator/upgrade-cloud-on-k8s) |
| Setting `vm.max_map_count` and running without `node.store.allow_mmap: false` | [Virtual memory](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/virtual-memory) |

### Support model

ECK and the Elastic Stack are Elastic products. For operator or Elastic Stack defects, refer to Elastic's documentation and support channels. This guide covers running them on ACP.

## Troubleshooting

| Symptom | Likely cause | Fix |
| :--- | :--- | :--- |
| Pods stuck in `Init:ErrImagePull` / `Init:ImagePullBackOff` | Image not (yet) in `$PRIVATE_REGISTRY` under `elasticsearch/elasticsearch` or `kibana/kibana`, or the registry requires login | Finish/verify the mirror (Step 1) and check the image path in `kubectl -n "$NS" get pod <pod> -o jsonpath='{.spec.containers[0].image}'`; for authenticated registries see Step 2. After fixing, delete the pod to retry immediately instead of waiting for the pull back-off |
| Cluster health `yellow` on a single node | An index has replicas that cannot be placed on one node | Create indices with `"number_of_replicas": 0` on single-node clusters, or add nodes |
| PVC stays `Pending` | `storageClassName` missing or wrong; `WaitForFirstConsumer` classes bind only when the pod is scheduled | Check `kubectl get sc` and the `volumeClaimTemplates` of the `Elasticsearch` resource |

## References

- [Elastic Cloud on Kubernetes](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)
- [Install ECK using the YAML manifests](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/install-using-yaml-manifest-quickstart)
- [Deploy an Elasticsearch cluster](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/elasticsearch-deployment-quickstart)
- [Deploy a Kibana instance](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/kibana-instance-quickstart)
- [Air-gapped installation](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/air-gapped-install)
- [ECK release notes](https://www.elastic.co/docs/release-notes/cloud-on-k8s)
- [Elastic licensing](https://www.elastic.co/pricing/faq/licensing)
