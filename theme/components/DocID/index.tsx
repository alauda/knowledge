import { usePageData } from "@rspress/core/runtime";
import { useMemo } from "react";

export const DocID = ({ id }: { id?: string }) => {
  const pageData = usePageData();

  const docID = useMemo(() => {
    return id || (pageData.page.frontmatter.id as string);
  }, [id, pageData]);
  return docID ? (
    <div className="rp-flex rp-text-sm rp-text-text-2 rp-leading-6 sm:rp-leading-8 rp-font-medium">
      ID: {docID}
    </div>
  ) : (
    <></>
  );
};
