---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500037
---

# x509 client certificate authentication and the kube-apiserver client-CA bundle on ACP

## Issue

On Alauda Container Platform (Kubernetes v1.34.5), administrators integrating an external identity or workload that presents a client certificate need to understand how the kube-apiserver decides whether to trust that certificate. The API server authenticates a request that carries an x509 client certificate when the presented certificate chains to a certificate authority in the configured client-CA bundle and the certificate maps to a valid user identity. Certificates intended for this flow follow the standard TLS client-certificate form, requesting the `digital signature`, `key encipherment`, and `client auth` key usages.

## Resolution

This article describes the trust model conceptually. The on-cluster surface that delivers the additional client-CA bundle to the kube-apiserver is environment-managed on ACP and is not exposed as a user-editable resource at the CSR API shape that anchors this article; treat the procedure below as information about how trust is established, not as a configuration recipe.

Trust for client certificates is established by the CA bundle distributed to the API server: an x509 client certificate is validated against that distributed trust bundle, which is the generic Kubernetes mechanism for client-certificate authentication. A client certificate that chains to a CA carried in the API server's configured client-CA trust bundle, and that carries the `client auth` key usage alongside `digital signature` and `key encipherment`, is treated as a valid client-cert authentication candidate at the API server.

A PEM client-CA bundle is a plain text file holding one or more concatenated CA certificates, each delimited by the standard PEM markers:

```text
-----BEGIN CERTIFICATE-----
<base64-encoded CA certificate>
-----END CERTIFICATE-----
```

Once the trust bundle includes a given CA, a client presenting a certificate signed by that CA and carrying the `client auth` key usage authenticates to the kube-apiserver and is resolved to its mapped user identity.
