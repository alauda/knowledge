import { useI18n, usePageData } from "@rspress/core/runtime";
import { useMemo } from "react";

export const BreadCrumb = () => {
  const { page, siteData } = usePageData();
  const { base } = siteData;
  const t = useI18n();

  const href = useMemo(() => {
    if (!base) {
      return page.lang === "en" ? "/" : `/${page.lang}/`;
    }
    return `${base}${page.lang === "en" ? "" : page.lang}`;
  }, [page, base]);

  return (
    <div className="rp-mb-10">
      <span className="editLink" style={{ paddingLeft: 0 }}>
        <a href={href}>
          <span>{t("knowledge_title")}</span>
        </a>
      </span>
      <span style={{ fontSize: "15px", fontWeight: 500 }}>
        &nbsp;/&nbsp;<span>{page.title}</span>
      </span>
    </div>
  );
};
