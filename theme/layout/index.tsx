import { usePageData } from "@rspress/core/runtime";
import {
  Badge,
  LastUpdated,
  Layout,
  getCustomMDXComponent,
} from "@rspress/core/theme-original";
import { useEffect } from "react";

import { BreadCrumb } from "../components/BreadCrumb";
import { DocID } from "../components/DocID";
import { EditOnGithub } from "../components/EditOnGithub";
import { downloadFile, getPathname, shouldDownload } from "../utils/download";
import HomeLayout from "./HomeLayout";

export function normalizeTags(tags: string | string[]): string[] {
  if (!tags) {
    return [];
  }
  if (Array.isArray(tags)) {
    return tags;
  }
  return [tags];
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
  useEffect(() => {
    window.parent.postMessage(window.location.href, "*");
  }, []);

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

          return (
            <CustomMDXComponent.a
              {...props}
              href=""
              onClick={(e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation?.();
                downloadFile(
                  props.href,
                  pathname.split("/").pop() || "download"
                );
              }}
            ></CustomMDXComponent.a>
          );
        },
      }}
    ></Layout>
  );
};
