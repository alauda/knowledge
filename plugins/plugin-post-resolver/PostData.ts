import path from "node:path";
import dayjs from "dayjs";
import grayMatter from "gray-matter";
import { PostInfo } from "./types";
import {
  excerptFilter,
  extractTitle,
  generateRoutePath,
  getGitLastUpdatedTimeStamp,
  normalizeTags,
  transformTime,
} from "./utils";

export const postInfos: PostInfo[] = [];
export const postProducts: string[] = [];
export const postKinds: string[] = [];

export function resetPostInfo() {
  postProducts.length = 0;
  postKinds.length = 0;
  postInfos.length = 0;
}

export async function getPostInfo(
  filepath: string,
  baseDir: string
): Promise<PostInfo | null> {
  let filename = path.basename(filepath.toString());
  const extname = path.extname(filename);
  if ([".mdx", ".md", ".html"].indexOf(extname) === -1) {
    return null;
  }

  const relativePath = path.relative(baseDir, filepath);

  const routePath = generateRoutePath(relativePath);

  const lastUpdated = await getGitLastUpdatedTimeStamp(filepath);

  const locale = routePath.split("/")[1];

  if (routePath === "/") {
    return null;
  }

  const {
    data: frontmatter,
    excerpt,
    content,
  } = grayMatter.read(filepath, {
    excerpt: excerptFilter,
  });

  if (frontmatter.pageType === "home") {
    return null;
  }

  const contentTitle = extractTitle(content);
  const createTime = dayjs(frontmatter.date) || dayjs();
  const lastUpdatedTimestamp = lastUpdated || Date.now();
  return {
    title: frontmatter.title || contentTitle || filename,
    route: locale === "en" ? routePath.slice(3) : routePath,
    path: filepath,
    date: createTime.format("YYYY-MM-DD HH:mm:ss"),
    kinds: normalizeTags(frontmatter.kind || frontmatter.kinds),
    products: normalizeTags(frontmatter.product || frontmatter.products),
    id: frontmatter.id,
    excerpt: frontmatter.description || excerpt,
    locale,
    lastUpdatedTime: transformTime(lastUpdatedTimestamp, locale),
    lastUpdatedTimestamp,
  };
}

export function addPost(post: PostInfo) {
  postInfos.push(post);

  postProducts.push(...post.products);
  postKinds.push(...post.kinds);
}

export function sortPostInfos() {
  postInfos.sort((a, b) => {
    return b.lastUpdatedTimestamp - a.lastUpdatedTimestamp;
  });
}
