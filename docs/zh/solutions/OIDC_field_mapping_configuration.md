---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB1757070945-89B1
sourceSHA: 997ad3c2335fa9ae3a8fd471961bbc1be23e5eacf8b5a487bbe82293fca374d0
---

# OIDC 字段映射配置

## 问题

在集成第三方 OIDC（OpenID Connect）服务时，常常会遇到身份验证回调失败，错误信息通常为：

`内部错误：身份验证失败：缺少电子邮件声明，未找到 \"email\" 键`

平台在 OIDC 身份验证过程中请求默认的作用域 `profile` 和 `email`。然而，一些第三方 OIDC 提供者可能不会以预期格式返回标准字段。

**常见错误信息：**

- 缺少 "email" 声明：缺少电子邮件字段
- 缺少 "email_verified" 声明：缺少电子邮件验证字段
- 缺少 "name" 声明：缺少姓名字段

## 环境

- 4.x
- 3.x

## 解决方案

平台提供了字段映射功能来处理这些非标准情况。

### 对于平台版本 4.x

1. 导航到 管理员 → 用户 → IDP → 点击进入 OIDC 集成详情 → 在操作的右侧点击更新 → 切换到 YAML 视图

2. 在 YAML 中配置字段映射：

```yaml
spec:
  config:
    # 其他配置
    # 如果提供者无法提供 email_verified 字段，则可以跳过电子邮件验证检查。
    insecureSkipEmailVerified: true
    
    # 使用其他字段作为显示名称；默认是姓名字段。
    userNameKey: display_name
    
    # 如果提供者的 /.well-known/openid-configuration 提供了 userinfo_endpoint，则可以启用 UserInfo 端点查询。
    getUserInfo: true
    
    # 字段映射配置
    claimMapping:
      # 如果提供者无法提供 email 字段，可以使用 'sub' 作为替代。
      # 除了 sub 字段，其他可以唯一表示用户的全局字段也可以使用。
      # 默认电子邮件
      email: sub
      
      # 如果提供者使用 'user_groups' 而不是 'groups'
      # 默认组
      groups: user_groups
      
      # 如果提供者使用 'mobile' 而不是 'phone'
      phone: mobile
```

3. 在 IDP 配置中更新字段映射后，用户可以再次尝试使用 OIDC 登录。

有关 4.x 版本的详细文档，请参阅：<https://docs.alauda.io/container_platform/4.1/security/users_and_roles/idp/functions/oidc_manage.html>

### 对于平台版本 3.x

1. 在 global 集群中执行以下命令：

```bash
# 检索连接的提供者。
kubectl get connectors -n cpaas-system

# 编辑连接器信息
kubectl edit connector -n cpaas-system <connector name>
```

2. 使用 Base64 解码 config 字段的值。

提供者的配置信息将以 JSON 格式显示。此时，您可以根据 4.x 版本的字段配置更新 JSON 中的配置。最后，将信息编码为 base64 并更新到连接器资源。

更新连接器配置后，您可以再次使用 OIDC 登录平台。

## 根本原因

此类问题的根本原因是第三方 OIDC 服务返回的 ID 令牌缺少标准的强制字段，导致系统无法正确解析用户信息。

ID 令牌包含标准声明，声明哪个客户端应用程序登录了用户、令牌何时过期以及用户的身份。

**标准 ID 令牌示例：**

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

## 诊断步骤

1. **检查 ID 令牌内容**：您可以使用在线 JWT 解码工具（如 <https://jwt.io>）查看 ID 令牌的实际内容，并了解 OIDC 服务提供了哪些字段。

2. **咨询 IDP 提供者**：为了映射所需字段，请咨询 IDP 提供者的操作人员，以确定在授权期间提供了哪些字段。

3. **验证身份验证流程**：测试 OIDC 身份验证过程，以识别错误信息中具体缺失的声明。
