import { useI18n, usePageData, useSite } from "@rspress/runtime";

interface StyledProps {
  className?: string;
}

interface BannerProps extends StyledProps {
  className?: string;
}

export const HomeBanner: React.FC<BannerProps> = ({ className }) => {
  const pageData = usePageData();
  const siteData = useSite();
  console.log(pageData, siteData);
  const t = useI18n();

  // const logo =
  //   typeof pageData.siteData.logo === "string"
  //     ? pageData.siteData.logo
  //     : pageData.siteData.themeConfig.darkMode
  //     ? pageData.siteData.logo.dark
  //     : pageData.siteData.logo.light;

  return (
    <div className={className}>
      <div className="max-w-3/5">
        <h1 className="!text-xl !font-semibold !mb-6">
          {/* {pageData.siteData.title} */}
          {t("knowledge_title")}
        </h1>
        <p className="">
          {/* {pageData.siteData.description} */}
          {t("knowledge_description")}
        </p>
      </div>
      <img width={180} src={`${pageData.siteData.base}180.png`}></img>
    </div>
  );
};
