---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Updating a NetworkAttachmentDefinition's `spec.config` JSON Safely

## Issue

A `NetworkAttachmentDefinition` (NAD) needs to have one of its configuration parameters changed — for example, switching the CNI plugin `type` from `bridge` to `cnv-bridge` so VMs on ACP Virtualization can share the same underlying host bridge through KubeVirt's MAC-spoof / VLAN-preservation extensions, or adjusting a VLAN tag, MTU, or IPAM block without recreating the NAD object.

The field that holds the configuration is `spec.config`, declared as a JSON **string**, not a nested YAML structure. That subtlety changes how it can be updated: an editor change merges into the existing string transparently, while a programmatic `kubectl patch` call replaces the entire string in one go. A patch that omits any field already present in `spec.config` erases that field.

## Resolution

Two approaches, chosen by how many NADs need the same change.

### Manual edit — single NAD, interactive

For a one-off update, open the NAD in the default editor and edit the inner JSON as if it were an ordinary string value:

```bash
kubectl -n <ns> edit networkattachmentdefinition <nad-name>
```

Inside the editor, locate the `spec.config:` line. The value is a single JSON document packed into a YAML string; update the field in place (for example change `"type": "bridge"` to `"type": "cnv-bridge"`) and save. The object is validated and persisted on save; Multus picks up the change on the next pod that binds to this NAD. Pods already attached keep the previous configuration until they are recreated.

### Programmatic patch — batch updates, one NAD at a time

When several NADs need the same parameter change, `kubectl patch` with `--type=merge` is the efficient path:

```bash
kubectl -n <ns> patch networkattachmentdefinition <nad-name> \
  --type=merge \
  -p '{"spec":{"config":"{\"cniVersion\":\"0.3.1\",\"name\":\"br5\",\"type\":\"cnv-bridge\",\"bridge\":\"br0\",\"macspoofchk\":true,\"preserveDefaultVlan\":false,\"vlan\":5}"}}'
```

There are three non-obvious requirements for this patch to work correctly:

1. The outer patch document is YAML/JSON; the inner `spec.config` value is a string that itself holds JSON. That means every double quote inside `spec.config` must be backslash-escaped (`\"`). Shell quoting the outer string with single quotes, as in the example above, lets the escapes reach kubectl unchanged.

2. The string value must be **the complete JSON** the NAD should end up with, not a delta. `--type=merge` merges the *outer* fields but treats the inner string as an opaque blob — any field not present in the new string is lost. Always read the current NAD first, apply the intended delta in your editor or a script, then write the full replacement string:

   ```bash
   kubectl -n <ns> get networkattachmentdefinition <nad-name> \
     -o jsonpath='{.spec.config}{"\n"}'
   ```

3. Scripting the same update across many NADs is straightforward when the before/after delta is known. The pattern: fetch `spec.config`, parse it as JSON, modify the field, and patch with the updated string:

   ```bash
   for nad in $(kubectl -n <ns> get networkattachmentdefinition -o name); do
     CUR=$(kubectl -n <ns> get "$nad" -o jsonpath='{.spec.config}')
     NEW=$(jq -c '.type = "cnv-bridge"' <<< "$CUR")
     kubectl -n <ns> patch "$nad" --type=merge \
       -p "{\"spec\":{\"config\":$(jq -Rs . <<< "$NEW")}}"
   done
   ```

   `jq -Rs .` re-serialises the JSON string as a JSON *string* literal, producing the correct escaping for the patch body.

### What not to do

- Do not use `kubectl patch --type=json` with a JSON-Patch `replace` operation against a sub-field inside `spec.config`. The string is atomic; JSON-Patch cannot address fields inside a string. The operation either no-ops or fails, depending on the kubectl version.
- Do not pipe the inner JSON directly into the patch without escaping. Unescaped double quotes end the patch string prematurely and kubectl rejects the payload with a confusing parse error.
- Do not edit the NAD object's `data` fields directly via `kubectl replace -f` if the file was generated without the round-tripped `spec.config` string — the outer YAML shape is fine but regenerating the inner JSON string by hand almost always introduces whitespace drift and breaks Multus's comparison.

## Diagnostic Steps

After the update, confirm the change landed by reading the effective `spec.config`:

```bash
kubectl -n <ns> get networkattachmentdefinition <nad-name> \
  -o jsonpath='{.spec.config}{"\n"}' \
  | jq .
```

`jq` will refuse to parse the string if the patch broke the JSON (stray escape, missing comma), which is the fastest way to catch a malformed patch.

Verify no pod is using a stale configuration. Pods bound to the NAD at attach time do not pick up edits; a running pod sees whatever config was current when its network was plumbed. Find the bound pods:

```bash
kubectl get pod -A -o json | \
  jq -r '.items[] | select(.metadata.annotations["k8s.v1.cni.cncf.io/networks"]?
                           | strings | contains("<nad-name>"))
         | "\(.metadata.namespace)/\(.metadata.name)"'
```

To let the changes take effect for those pods, delete each one and let the controller recreate it with the new NAD state.

For VMs on ACP Virtualization, restarting the VMI (not just editing the VM object) causes `virt-launcher` to re-bind to the updated NAD:

```bash
kubectl -n <ns> delete vmi <vm-name>
kubectl -n <ns> get vmi <vm-name> -w
```

Inspect `virt-launcher` events on the new pod to confirm the updated CNI `type` was picked up — the event log includes the effective CNI name used to plumb the NIC.
