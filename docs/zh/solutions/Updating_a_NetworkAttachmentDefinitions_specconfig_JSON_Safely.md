---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 35ad9de91cba682696b0f207f0a155f3d3435e556c4492333672158d5c4cb9e9
---

# 安全更新 NetworkAttachmentDefinition 的 `spec.config` JSON

## 问题

需要更改 `NetworkAttachmentDefinition` (NAD) 的一个配置参数——例如，将 CNI 插件 `type` 从 `bridge` 切换为 `cnv-bridge`，以便在 ACP 虚拟化上，虚拟机可以通过 KubeVirt 的 MAC 欺骗 / VLAN 保留扩展共享相同的底层主机桥，或者在不重新创建 NAD 对象的情况下调整 VLAN 标签、MTU 或 IPAM 块。

持有配置的字段是 `spec.config`，声明为 JSON **字符串**，而不是嵌套的 YAML 结构。这一细微之处改变了它的更新方式：编辑器的更改会透明地合并到现有字符串中，而程序化的 `kubectl patch` 调用则一次性替换整个字符串。省略 `spec.config` 中任何已存在字段的补丁会删除该字段。

## 解决方案

有两种方法，取决于需要相同更改的 NAD 数量。

### 手动编辑 — 单个 NAD，交互式

对于一次性更新，打开 NAD 在默认编辑器中，并像处理普通字符串值一样编辑内部 JSON：

```bash
kubectl -n <ns> edit networkattachmentdefinition <nad-name>
```

在编辑器中，找到 `spec.config:` 行。该值是一个打包在 YAML 字符串中的单个 JSON 文档；就地更新字段（例如将 `"type": "bridge"` 更改为 `"type": "cnv-bridge"`）并保存。对象在保存时会被验证并持久化；Multus 会在下一个绑定到此 NAD 的 pod 上获取更改。已经附加的 pods 保持先前的配置，直到它们被重新创建。

### 程序化补丁 — 批量更新，每次一个 NAD

当多个 NAD 需要相同的参数更改时，使用 `kubectl patch` 和 `--type=merge` 是高效的路径：

```bash
kubectl -n <ns> patch networkattachmentdefinition <nad-name> \
  --type=merge \
  -p '{"spec":{"config":"{\"cniVersion\":\"0.3.1\",\"name\":\"br5\",\"type\":\"cnv-bridge\",\"bridge\":\"br0\",\"macspoofchk\":true,\"preserveDefaultVlan\":false,\"vlan\":5}"}}'
```

为了使此补丁正确工作，有三个不明显的要求：

1. 外部补丁文档是 YAML/JSON；内部 `spec.config` 值是一个字符串，内部持有 JSON。这意味着 `spec.config` 内的每个双引号必须进行反斜杠转义 (`\"`)。如上例所示，使用单引号对外部字符串进行 Shell 引号处理，可以让转义字符不变地传递给 kubectl。

2. 字符串值必须是 NAD 最终应该得到的 **完整 JSON**，而不是增量。`--type=merge` 合并 *外部* 字段，但将内部字符串视为不透明的 blob——新字符串中未出现的任何字段都会丢失。始终先读取当前 NAD，在编辑器或脚本中应用预期的增量，然后写入完整的替换字符串：

   ```bash
   kubectl -n <ns> get networkattachmentdefinition <nad-name> \
     -o jsonpath='{.spec.config}{"\n"}'
   ```

3. 当已知前后增量时，在多个 NAD 上脚本化相同的更新是简单的。模式：获取 `spec.config`，将其解析为 JSON，修改字段，然后用更新的字符串进行补丁：

   ```bash
   for nad in $(kubectl -n <ns> get networkattachmentdefinition -o name); do
     CUR=$(kubectl -n <ns> get "$nad" -o jsonpath='{.spec.config}')
     NEW=$(jq -c '.type = "cnv-bridge"' <<< "$CUR")
     kubectl -n <ns> patch "$nad" --type=merge \
       -p "{\"spec\":{\"config\":$(jq -Rs . <<< "$NEW")}}"
   done
   ```

   `jq -Rs .` 重新序列化 JSON 字符串为 JSON *字符串* 字面量，为补丁主体生成正确的转义。

### 不要做的事情

- 不要使用 `kubectl patch --type=json` 对 `spec.config` 内部的子字段进行 JSON-Patch `replace` 操作。该字符串是原子的；JSON-Patch 无法访问字符串内部的字段。该操作要么无效，要么失败，具体取决于 kubectl 版本。
- 不要在补丁中直接将内部 JSON 管道传输而不进行转义。未转义的双引号会提前结束补丁字符串，kubectl 会因解析错误而拒绝负载。
- 如果文件是未经过 `spec.config` 字符串的回转生成的，请不要通过 `kubectl replace -f` 直接编辑 NAD 对象的 `data` 字段——外部 YAML 结构是可以的，但手动重新生成内部 JSON 字符串几乎总是会引入空格漂移，并破坏 Multus 的比较。

## 诊断步骤

更新后，通过读取有效的 `spec.config` 来确认更改是否生效：

```bash
kubectl -n <ns> get networkattachmentdefinition <nad-name> \
  -o jsonpath='{.spec.config}{"\n"}' \
  | jq .
```

如果补丁破坏了 JSON（多余的转义，缺少逗号），`jq` 将拒绝解析该字符串，这是捕获格式错误补丁的最快方法。

验证没有 pod 使用过时的配置。在附加时绑定到 NAD 的 pods 不会获取编辑；正在运行的 pod 看到的是其网络连接时的当前配置。查找绑定的 pods：

```bash
kubectl get pod -A -o json | \
  jq -r '.items[] | select(.metadata.annotations["k8s.v1.cni.cncf.io/networks"]?
                           | strings | contains("<nad-name>"))
         | "\(.metadata.namespace)/\(.metadata.name)"'
```

为了让这些 pods 的更改生效，删除每个 pod 并让控制器使用新的 NAD 状态重新创建它。

对于 ACP 虚拟化上的虚拟机，重启 VMI（而不仅仅是编辑 VM 对象）会导致 `virt-launcher` 重新绑定到更新后的 NAD：

```bash
kubectl -n <ns> delete vmi <vm-name>
kubectl -n <ns> get vmi <vm-name> -w
```

检查新 pod 上的 `virt-launcher` 事件，以确认已获取更新的 CNI `type`——事件日志包括用于连接 NIC 的有效 CNI 名称。
