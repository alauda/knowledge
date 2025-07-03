import { Badge, LastUpdated, Layout } from "rspress/theme";
import { usePageData } from "rspress/runtime";
import { useEffect, useMemo } from "react";
import HomeLayout from "./HomeLayout";
import { EditOnGithub } from "../components/EditOnGithub";
import { DocID } from "../components/DocID";
import { BreadCrumb } from "../components/BreadCrumb";

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
  const { page } = usePageData();

  const uiSwitch = useMemo(
    () =>
      page.pageType === "doc"
        ? { showSidebar: false, showDocFooter: false }
        : {},
    [page]
  );

  useEffect(() => {
    window.parent.postMessage(window.location.href, "*");
  }, []);

  return (
    <Layout
      uiSwitch={uiSwitch}
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
      // components={{
      //   h1: (props: any) => {
      //     const CustomMDXComponent = getDefaultCustomMDXComponent();
      //     const { page } = usePageData();
      //     return page.pageType === "doc" ? (
      //       <>
      //         <CustomMDXComponent.h1 {...props}   />

      //         <div className="flex justify-between" style={{marginTop:'-1.5rem'}}>
      //           <LastUpdated></LastUpdated>
      //           <DocID></DocID>
      //         </div>
      //       </>
      //     ) : (
      //       <CustomMDXComponent.h1 {...props} />
      //     );
      //   },
      // }}
    ></Layout>
  );
};
