---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Setting a Custom Icon on a VM Template via the `iconClass` Annotation
## Issue

A VM template offered through the ACP console's catalog should display a custom icon — a vendor logo, an application's own branding, a distinguishing visual for templates that would otherwise blend together — instead of the generic OS icon the catalog picks by default. Editing the template's `spec` has no effect on how it renders in the catalog; the icon is controlled by an annotation on the template's `metadata`, not by any spec field.

## Resolution

Add an `iconClass` annotation to the template. The value is either a public URL pointing at an image (PNG / SVG) or a built-in icon class the catalog recognises:

```yaml
apiVersion: template.kubevirt.io/v1
kind: VirtualMachineTemplate
metadata:
  name: my-custom-vm-template
  namespace: my-templates
  annotations:
    # URL form — the console fetches and displays this image.
    iconClass: https://example.com/brand/app-icon.svg
    # Alternative: class-name form for a built-in icon shipped with the console.
    # iconClass: icon-linux
spec:
  # ... VM template spec ...
```

Apply and the console re-renders the catalog with the new icon. The change is cosmetic only — templates already instantiated into running VMs are unaffected.

### Where the icon shows up

Two distinct views render templates, and historically they did not both honour the annotation:

- **Software Catalog → Templates** (ecosystem-wide template browser): honours `iconClass` for any template, regardless of what it provisions. This is typically where custom-icon templates show their branding as expected.
- **Virtualization → Template Catalog** (VM-focused view): on older console versions this view rendered only a built-in set of hard-coded OS icons and ignored `iconClass`. On current console versions (4.21+ era), this view also respects `iconClass` — the same template renders with the same icon in both catalogs.

If the icon shows in one view but not the other, check the console version. On older versions, the absence of the custom icon in the virt-focused catalog is a known limitation, not a mistake in the annotation — the template's annotation is correct; the view is the one not reading it.

### Image choice

The URL form works well for publicly-hosted logos but is only honoured if the console can reach the URL. For air-gapped clusters the URL must point at an endpoint inside the cluster network — typically the cluster's own registry or a ConfigMap-backed static-file service. For SVG images, use a square aspect ratio and a modest pixel resolution (64×64 or 128×128); the catalog scales the image down and oversize uploads are wasteful.

Built-in class names (prefixed `icon-`, e.g. `icon-linux`, `icon-fedora`, `icon-windows`) map to bundled assets and need no external URL. They are the right choice when the template is branded to a distribution that already ships an icon.

### Applying across many templates

For an organisation that maintains dozens of templates under its own branding, apply the annotation consistently at template-authoring time (via the template's source manifest in Git), not through one-off `kubectl annotate` commands. A post-merge sweep like:

```bash
for tpl in $(kubectl -n my-templates get virtualmachinetemplates -o name); do
  kubectl -n my-templates annotate "$tpl" \
    iconClass=https://my-registry.example.com/icons/custom.svg --overwrite
done
```

can bulk-apply an existing annotation but overwrites any per-template icon that the authors intended to differ. Prefer the per-template annotation in the Git source.

## Diagnostic Steps

Inspect a template's current annotations to confirm `iconClass` is set and the value is what you expect:

```bash
kubectl -n my-templates get virtualmachinetemplate my-custom-vm-template \
  -o jsonpath='{.metadata.annotations.iconClass}{"\n"}'
```

If the URL form is in use, fetch the URL from inside the cluster to confirm the console can reach it:

```bash
kubectl run icon-probe --image=busybox --rm -it --restart=Never -- \
  wget -qO- https://example.com/brand/app-icon.svg | head -5
```

A non-empty response is positive; a `Connection refused` / DNS failure means the URL is unreachable from the cluster network. Fix network reachability or switch to a URL served from inside the cluster.

After applying, open the console's catalog view, refresh, and confirm the icon renders. If the catalog still shows the generic icon and the template's annotation is correct, check the console version and scope of the fix — older consoles only applied the annotation in certain views.
