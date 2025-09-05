---
products: 
   - Alauda Container Platform
kind:
   - Solution
id: KB1757070945-89B1
---

# OIDC Field Mapping Configuration

## Issue

When integrating third-party OIDC (OpenID Connect) services, authentication callback failures are frequently encountered, with the error message typically being:

`Internal error occurred: failed to authenticate: missing email claim, not found \"email\" key`

The platform requests the default scopes `profile` and `email` during OIDC authentication. However, some third-party OIDC providers may not return standard fields in the expected format.

**Common error messages:**

- missing "email" claim: Missing email field
- missing "email_verified" claim: Missing email verification field
- missing "name" claim: Missing name field

## Environment

- 4.x
- 3.x

## Resolution

The platform provides a field mapping feature to handle these non-standard situations.

### For Platform Version 4.x

1. Navigate to Administrator → Users → IDP → Click to enter OIDC integration details → Click Update on the right side of Actions → Switch to YAML view

2. Configure field mapping in the YAML:

```yaml
spec:
  config:
    # Other configurations
    # If the Provider cannot provide the email_verified field, the email verification check can be skipped.
    insecureSkipEmailVerified: true
    
    # Use other fields as the display name; the default is the name field.
    userNameKey: display_name
    
    # If the provider's /.well-known/openid-configuration provides a userinfo_endpoint, the UserInfo endpoint query can be enabled.
    getUserInfo: true
    
    # Field Mapping Configuration
    claimMapping:
      # If the provider cannot provide the email field, 'sub' can be used as a substitute.
      # In addition to the sub field, other fields that can uniquely represent a user globally may also be used.
      # Default email
      email: sub
      
      # If the provider uses 'user_groups' instead of 'groups'
      # Default groups
      groups: user_groups
      
      # If the provider uses 'mobile' instead of 'phone'
      phone: mobile
```

3. After updating the field mappings in the IDP configuration, users can attempt to log in again using OIDC.

For detailed documentation related to version 4.x, please refer to: [https://docs.alauda.io/container_platform/4.1/security/users_and_roles/idp/functions/oidc_manage.html](https://docs.alauda.io/container_platform/4.1/security/users_and_roles/idp/functions/oidc_manage.html)

### For Platform Version 3.x

1. Execute the following commands in the global cluster:

```bash
# Retrieve the connected provider(s).
kubectl get connectors -n cpaas-system

# Edit connector information
kubectl edit connector -n cpaas-system <connector name>
```

2. Decode the value of the config field using Base64.

The configuration information of the Provider will be displayed in JSON format. At this point, you can update the configuration in the JSON according to the field configuration of version 4.x. Finally, encode the information in base64 and update it to the connector resource.

After updating the Connector configuration, you can use OIDC to log in to the platform again.

## Root Cause

The root cause of this type of issue is that the ID Token returned by the third-party OIDC service lacks standard mandatory fields, preventing the system from correctly parsing user information.

ID Tokens contain standard claims that assert which client app logged the user in, when the token expires, and the identity of the user.

**Standard ID Token example:**

```json
{
  "iss": "http://127.0.0.1:5556/dex",
  "sub": "CgcyMzQyNzQ5EgZnaXRodWI",
  "aud": "example-app",
  "exp": 1492882042,
  "iat": 1492795642,
  "at_hash": "bi96gOXZShvlWYtal9Eqiw",
  "email": "jane.doe@coreos.com",
  "email_verified": true,
  "groups": [
    "admins",
    "developers"
  ],
  "name": "Jane Doe"
}
```

## Diagnostic Steps

1. **Check the ID Token content**: You can use an online JWT decoding tool (such as [https://jwt.io](https://jwt.io)) to view the actual content of the ID Token and understand which fields the OIDC service provides.

2. **Consult the IDP provider**: To map the required fields, consult the IDP provider's operations personnel to determine which fields were provided during authorization.

3. **Verify authentication flow**: Test the OIDC authentication process to identify specific missing claims in the error messages.
