#!/usr/bin/env bash
set -euo pipefail

# 获取文件最后修改时间（兼容 macOS 和 Linux）
mtime() {
  local f="$1"
  if stat -c %Y "$f" &>/dev/null; then
    stat -c %Y "$f"      # Linux
  else
    stat -f %m "$f"      # macOS
  fi
}

# 生成短 hash，兼容 macOS 和 Linux
file_hash() {
  local f="$1"
  if command -v md5sum &>/dev/null; then
    echo -n "$f" | md5sum | cut -c1-4 | tr 'a-f' 'A-F'
  else
    # macOS
    echo -n "$f" | md5 -q | cut -c1-4 | tr 'a-f' 'A-F'
  fi
}

# 检查 front matter 是否存在
has_frontmatter() {
  head -1 "$1" | grep -q '^---'
}

# 检查是否已有 id 字段（兼容 CRLF/LF 和行首空格）
has_id() {
  awk '
    BEGIN { in_front_matter=0; found=0 }
    {
      # 去掉行尾回车
      sub(/\r$/, "")
    }
    /^\s*---\s*$/ {
      if (in_front_matter==0) { in_front_matter=1; next }
      else if (in_front_matter==1) { exit(found==1?0:1) }
    }
    in_front_matter==1 && $0 ~ /^\s*id:/ { found=1 }
    END { exit(found==1?0:1) }
  ' "$1"
}


# 插入 id 到已有 front matter（放到 id 字段不存在时）
insert_id() {
  local file="$1" new_id="$2"
  awk -v newid="$new_id" '
    BEGIN { in_front_matter=0; added=0 }
    {
      if ($0 ~ /^\s*---\s*$/) {
        if (in_front_matter==0) { in_front_matter=1; print; next }
        else if (in_front_matter==1 && added==0) { print "id: " newid; added=1; print; in_front_matter=2; next }
      }
      if (in_front_matter==1 && added==0 && $0 ~ /^\s*$/) { print "id: " newid; added=1 }
      print
    }
  ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
}

# 添加 front matter + id 到无 front matter 的文件
add_full_frontmatter() {
  local file="$1" new_id="$2"
  {
    echo "---"
    echo "id: $new_id"
    echo "---"
    cat "$file"
  } > "$file.tmp" && mv "$file.tmp" "$file"
}

files=()
for target in "$@"; do
  if [ -d "$target" ]; then
    while IFS= read -r file; do
      files+=("$file")
    done < <(find "$target" -type f -name '*.md')
  else
    files+=("$target")
  fi

  for f in "${files[@]}"; do
    [[ "${f##*.}" != "md" ]] && continue
    ts=$(mtime "$f")
    hash=$(file_hash "$f")
    new_id="KB${ts}-${hash}"

    if has_frontmatter "$f"; then
      if has_id "$f"; then
        echo "[OK]   $f  (已有 id)"
      else
        insert_id "$f" "$new_id"
        echo "[ADD]  $f  (添加 id: $new_id)"
      fi
    else
      add_full_frontmatter "$f" "$new_id"
      echo "[NEW]  $f  (添加 front matter 和 id: $new_id)"
    fi
  done
done
