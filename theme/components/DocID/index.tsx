import { usePageData } from "@rspress/core/runtime";
import { useMemo } from "react";

export const DocID = ({ id }: { id?: string }) => {
  const pageData = usePageData();

  const docID = useMemo(() => {
    return id || (pageData.page.frontmatter.id as string);
  }, [id, pageData]);
  return docID ? (
    <div className="post-meta">
      ID: {docID}
    </div>
  ) : (
    <></>
  );
};
