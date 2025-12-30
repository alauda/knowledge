#!/usr/bin/env bash
set -euo pipefail

XSY_TOKEN="${XSY_TOKEN:-}"

# 获取文件最后修改时间（兼容 macOS 和 Linux）
mtime() {
  local f="$1"
  if stat -c %Y "$f" &>/dev/null; then
    stat -c %Y "$f"      # Linux
  else
    stat -f %m "$f"      # macOS
  fi
}

get_token() {
  local user="${XSY_USERNAME:?需要设置环境变量 XSY_USERNAME}"
  local pass="${XSY_PASSWORD:?需要设置环境变量 XSY_PASSWORD}"
  local client_id="${XSY_CLIENT_ID:?需要设置环境变量 XSY_CLIENT_ID}"
  local client_secret="${XSY_CLIENT_SECRET:?需要设置环境变量 XSY_CLIENT_SECRET}"

  local response
  response=$(curl -sS -X POST 'https://login.xiaoshouyi.com/auc/oauth2/token' \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d "client_id=${client_id}" \
    -d "client_secret=${client_secret}" \
    -d "grant_type=password" \
    -d "username=${user}" \
    -d "password=${pass}")
  
  local token
  token=$(echo "$response" | jq -r '.access_token // empty')
  if [ -z "$token" ]; then
    echo "Error: Failed to obtain access token" >&2
    echo "$response" >&2
    return 1
  fi
  echo "$token"
}


# 根据标题获取 KB ID
get_kb_id() {
  local title="$1"
  local escaped_title="${title//\'/\'\'}"
  curl -sS -G 'https://api.xiaoshouyi.com/rest/data/v2/query' \
    -H "Authorization: Bearer $XSY_TOKEN" \
    --data-urlencode "q=select solutionId__c from solution__c where name='$escaped_title' limit 1" \
    | jq -r '.result.records[0].solutionId__c // empty'
}

# 创建 KB
create_kb() {
  local title="$1"
  local description="$2"

  local response
  response=$(curl -sS -X POST 'https://api.xiaoshouyi.com/rest/data/v2/objects/solution__c' \
    -H "Authorization: Bearer $XSY_TOKEN" \
    -H "xsy-tenant-id: 182943" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n \
          --arg title "$title" \
          --arg desc "$description" \
          '{data: {name: $title, description__c: $desc, level__c: 3, entityType: 3168503772938632, accountId__c: 896461406896469, source__c: 6}}')")
  
  if [ -z "$response" ]; then
    echo "[ERR] 创建 KB 返回为空: $title" >&2
    return 1
  fi
  
  if ! echo "$response" | jq -e '.code == 200' >/dev/null 2>&1; then
    echo "[ERR] 创建 KB 失败: $title" >&2
    echo "$response" >&2
    return 1
  fi
  return 0
}

# 主流程：生成或获取 KB ID
generate_id() {
  local file="$1"
  local title description KB_ID

  # 假设你已有获取文件 title 的函数
  title=$(get_md_title "$file") 
  title=$(get_md_title "$file")
  if [ -z "$title" ]; then
    echo "Error: No title found in $file" >&2
    return 1
  fi

  description="auto generated from github"

  # 获取 token
  if [ -z "$XSY_TOKEN" ]; then
    XSY_TOKEN=$(get_token) || return 1
  fi

  # 查询 KB
  KB_ID=$(get_kb_id "$title")
  if [ -n "$KB_ID" ]; then
    echo "$KB_ID"
  else
    create_kb "$title" "$description" >/dev/null
    sleep 1
    KB_ID=$(get_kb_id "$title")
    echo "$KB_ID"
  fi
}

get_md_title() {
  local file="$1"

  # 取 front matter 之后，第一个以 "# " 开头的标题
  awk '
    BEGIN { in_fm = 0 }
    /^---$/ {
      in_fm = !in_fm
      next
    }
    !in_fm && /^# / {
      sub(/^# +/, "", $0)
      print
      exit
    }
  ' "$file"
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
    if has_frontmatter "$f"; then
      if has_id "$f"; then
        echo "[OK]   $f  (已有 id)"
      else
        if ! new_id=$(generate_id "$f") || [ -z "$new_id" ]; then
          echo "[FAIL] $f  (failed to generate id)" >&2
          continue
        fi
        insert_id "$f" "$new_id"
        echo "[ADD]  $f  (添加 id: $new_id)"
      fi
    else
      add_full_frontmatter "$f" "$new_id"
      echo "[NEW]  $f  (添加 front matter 和 id: $new_id)"
    fi
  done
done
