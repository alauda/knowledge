---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500040
sourceSHA: 25fee407ecac7690953c9fc581340d2b876658a537137c7926ff94ffc6dda257
---

# virt-v2v 转换在 Linux 客户机上失败，提示 "/lib/modules: No such file or directory"

## 问题

将 Linux 客户机从 VMware 迁移到集群的虚拟化堆栈 — 使用 VM 导入 / Forklift 工作流将转换委托给 `virt-v2v` — 在检查 / 转换阶段失败。转换 Pod 日志以 libguestfs 报告内核模块树无法找到结束：

```text
libguestfs: trace: v2v: find "/lib/modules/<kver>"
guestfsd:  error: /lib/modules/<kver>: No such file or directory
libguestfs: trace: v2v: find = NULL (error)
virt-v2v: error: libguestfs error: find0:
   /lib/modules/<kver>: No such file or directory
```

来自同一跟踪的 `/boot` 目录列表显示内核映像、匹配的 `initramfs` 和 `System.map` — 因此内核本身已安装并完好。只有 `/lib/modules/<kver>` 路径查找失败。

## 根本原因

现代 Linux 发行版将 `/lib` 作为指向 `/usr/lib` 的符号链接（`usr-merge` 布局）。该符号链接应该是 **相对** 的：

```text
/lib -> usr/lib
```

相关的客户机将其设置为 **绝对** 符号链接：

```text
/lib -> /usr/lib
```

从正在运行的系统内部看，这两者看起来是等效的，但 `virt-v2v` 并不在客户机内部运行 — 它通过 libguestfs 从外部检查客户机的根文件系统。libguestfs 根据客户机文件系统的根跟随符号链接，而不是主机的。当它跟随一个 *绝对* 符号链接时，前导的 `/` 解析到主机（`virt-v2v` 自身的根），而 `/usr/lib/modules/<kver>` 不存在。然后 `find` 返回“没有这样的文件”，转换中止。

相对的 `usr/lib` 符号链接被解释为相对于客户机内部符号链接目录的，这样可以正确地指向客户机的 `/usr/lib`，并找到模块树。

这是转换工具在检查期间处理符号链接的一个特性，而不是内核模块的问题。内核模块是存在的；libguestfs 只是无法通过绝对符号链接访问它们。

## 解决方案

修复在 **源** 客户机上，在重新运行迁移之前：将绝对的 `/lib` 符号链接替换为相对链接。启动源 VM（仍在其原始虚拟化环境上），以 root 身份运行：

```bash
cd /
ls -l lib                 # 确认: /lib -> /usr/lib  (绝对)
rm /lib
ln -s usr/lib /lib
readlink /lib             # 预期: usr/lib  (相对)
```

此更改向后兼容 — 每次读取 `/lib/...` 仍然解析为运行系统上的 `/usr/lib/...` — 并且在重启后保持不变。

在修正符号链接后，重新运行迁移。virt-v2v 将在检查期间正确跟随相对符号链接，找到 `/lib/modules/<kver>`，并继续完成转换。

### 为未来的迁移进行加固

如果一组客户机是从包含绝对符号链接的模板中配置的，则修复模板一次并重新基于它。对于长时间运行的客户机，触碰运行系统敏感的情况下，使用救援媒体的等效修复方法同样有效：chroot 进入客户机的根，替换符号链接，退出。无需触碰 `/usr/lib/modules` 本身。

如果客户机的 `/usr-merge` 是过去通过手动脚本执行的，值得审计所有顶级兼容性符号链接（`/bin`、`/sbin`、`/lib64`）以检查相同的绝对与相对错误 — 下一次 libguestfs 遇到时转换将再次失败。

## 诊断步骤

1. 检查转换 Pod 日志，确认失败路径为 `/lib/modules/<kver>`。其他 libguestfs 失败（缺少 initramfs、错误的根分区、没有密钥的加密磁盘）看起来表面上相似，但列出不同的路径：

   ```bash
   kubectl logs -n <virt-namespace> <conversion-pod> -c <converter-container> \
     | grep -E 'libguestfs error|virt-v2v: error|/lib/'
   ```

2. 从源 VM（或其救援媒体）检查符号链接：

   ```bash
   readlink /lib
   readlink /lib64 || true
   readlink /bin   || true
   readlink /sbin  || true
   ```

   任何以前导 `/` 开头的输出都是绝对符号链接，并且是相同故障的候选。

3. 确认内核模块实际上在客户机中存在，排除真正缺失模块的问题（在重建的客户机上很少见但可能）：

   ```bash
   ls -ld /usr/lib/modules/$(uname -r)
   ```

   如果目录存在，则转换失败纯粹是这里描述的符号链接问题。如果目录确实不存在，那是一个单独的问题（内核包安装损坏），而符号链接修复将无济于事。

4. 修复符号链接并重新运行迁移后，观察转换 Pod 对 `/lib/modules` 的下一个 libguestfs `find` — 它应该成功，运行应该进展到磁盘转换阶段：

   ```bash
   kubectl logs -n <virt-namespace> <new-conversion-pod> -f \
     | grep -E '/lib/modules|copying|inspecting'
   ```
