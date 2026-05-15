import { usePageData, withBase } from "@rspress/core/runtime";
import {
  Badge,
  LastUpdated,
  Layout,
  getCustomMDXComponent,
} from "@rspress/core/theme-original";
import { useEffect } from "react";
import { postInfos } from "virtual-post-data";

import { BreadCrumb } from "../components/BreadCrumb/index.js";
import { DocID } from "../components/DocID/index.js";
import { EditOnGithub } from "../components/EditOnGithub/index.js";
import HomeLayout from "./HomeLayout/index.js";
import { getPathname, shouldDownload } from "theme/utils/download";

export function normalizeTags(tags: string | string[]): string[] {
  if (!tags) {
    return [];
  }
  if (Array.isArray(tags)) {
    return tags;
  }
  return [tags];
}

function normalizePostId(id?: string): string {
  return id?.trim().toLowerCase() || "";
}

const initialHref = typeof window === "undefined" ? "" : window.location.href;

function getInitialHref(): string {
  return initialHref || window.location.href;
}

const Badges = () => {
  const { page } = usePageData();
  const kinds = normalizeTags(
    ((page.frontmatter.kinds || page.frontmatter.kind) as any) || ""
  );
  const products = normalizeTags(
    ((page.frontmatter.products || page.frontmatter.product) as any) || ""
  );
  const badges = [...kinds, ...products];
  return page.pageType === "doc" ? (
    <div className="flex">
      {badges.map((badge) => (
        <div className="mr-2" key={badge}>
          <Badge>{badge}</Badge>
        </div>
      ))}
    </div>
  ) : (
    <></>
  );
};

export default () => {
  const { page } = usePageData();

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const currentUrl = new URL(getInitialHref());
    const postId = currentUrl.searchParams.get("id")?.trim();
    const normalizedPostId = normalizePostId(postId);

    if (normalizedPostId) {
      const matchedPost =
        postInfos.find(
          (post) =>
            normalizePostId(post.id) === normalizedPostId &&
            post.locale === page.lang
        ) ||
        postInfos.find(
          (post) => normalizePostId(post.id) === normalizedPostId
        );

      if (matchedPost) {
        const nextUrl = new URL(
          withBase(
            matchedPost.route.endsWith(".html")
              ? matchedPost.route
              : `${matchedPost.route}.html`
          ),
          currentUrl.origin
        );

        currentUrl.searchParams.delete("id");
        nextUrl.search = currentUrl.searchParams.toString();
        nextUrl.hash = currentUrl.hash;

        if (nextUrl.toString() !== currentUrl.toString()) {
          window.location.replace(nextUrl.toString());
          return;
        }
      }
    }

    window.parent.postMessage(window.location.href, "*");
  }, [page.lang]);

  return (
    <Layout
      HomeLayout={HomeLayout}
      beforeDocContent={
        <>
          <BreadCrumb></BreadCrumb>
        </>
      }
      beforeDocFooter={<Badges></Badges>}
      afterDocFooter={
        <div className="flex justify-between">
          <LastUpdated></LastUpdated>
          <DocID></DocID>
        </div>
      }
      beforeOutline={<EditOnGithub></EditOnGithub>}
      components={{
        a: (props: any) => {
          const CustomMDXComponent = getCustomMDXComponent();
          const pathname = getPathname(props.href);
          if (!shouldDownload(pathname)) {
            return <CustomMDXComponent.a {...props}></CustomMDXComponent.a>;
          }

          const href = props.href ? withBase(props.href) : props.href;

          return (
            <a
              {...props}
              href={href}
              download={pathname.split("/").pop() || "download"}
              className="rp-link"
            ></a>
          );
        },
      }}
    ></Layout>
  );
};
