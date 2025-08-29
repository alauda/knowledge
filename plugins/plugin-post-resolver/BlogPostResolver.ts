import path from "node:path";
import fs, { PathLike } from "node:fs";
import { RspressPlugin } from "@rspress/shared";
import {
  addPost,
  getPostInfo,
  postInfos,
  postKinds,
  postProducts,
  resetPostInfo,
  sortPostInfos,
} from "./PostData";
import { PluginOptions } from "./types";
import { deDuplicate } from "./utils";

function traverseFolder(
  folderPath: PathLike,
  callback: (path: PathLike) => void
) {
  const items = fs.readdirSync(folderPath);
  items.forEach((item) => {
    const itemPath = path.join(folderPath.toString(), item);
    const stats = fs.statSync(itemPath);
    if (stats.isDirectory()) {
      traverseFolder(itemPath, callback);
    } else if (stats.isFile()) {
      callback(itemPath);
    }
  });
}

export function blogPostResolver(options?: PluginOptions): RspressPlugin {
  const { postsDir = process.cwd() } = options || {};
  return {
    name: "@yangxiaolang/rspress-plugin-post-resolver",
    async addRuntimeModules() {
      resetPostInfo();

      const promises: Promise<void>[] = [];
      traverseFolder(postsDir, (itemPath) => {
        const promise = getPostInfo(itemPath as string, postsDir).then(
          (postInfo) => {
            if (postInfo) {
              addPost(postInfo);
            }
          }
        );
        promises.push(promise);
      });

      await Promise.all(promises);

      sortPostInfos();

      return {
        "virtual-post-data": `
          export const postInfos = ${JSON.stringify(postInfos)}
        `,
        "virtual-post-postProducts": `
          export const postProducts = ${JSON.stringify(
            deDuplicate(postProducts)
          )}
        `,
        "virtual-post-postKinds": `
          export const postKinds = ${JSON.stringify(deDuplicate(postKinds))}
        `,
      };
    },
  };
}
