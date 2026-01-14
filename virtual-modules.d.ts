// 虚拟模块类型声明
declare module "virtual-post-data" {
  export interface PostInfo {
    id: string;
    title: string;
    route: string;
    path: string;
    date: string;
    kinds: string[];
    products: string[];
    excerpt: string;
    locale: string;
    lastUpdatedTime: string;
  }

  export const postInfos: PostInfo[];
}

declare module "virtual-post-postProducts" {
  export const postProducts: string[];
}

declare module "virtual-post-postKinds" {
  export const postKinds: string[];
}

