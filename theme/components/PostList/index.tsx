import { FC, useMemo } from "react";
import { PostInfo } from "../../../plugins/plugin-post-resolver";
import { Badge, LinkCard, useLocaleSiteData } from "rspress/theme";
import { useI18n, usePageData } from "rspress/runtime";
import { Markdown } from "@alauda/doom/runtime";
import EmptyState from "../Empty";
import { DocID } from "../DocID";

interface PostListProps {
  postList: PostInfo[];
}

export const PostList: FC<PostListProps> = ({ postList }) => {
  const notEmpty = useMemo(() => postList.length > 0, [postList]);
  const t = useI18n();

  const { siteData } = usePageData();

  const { base } = siteData;

  const { lastUpdatedText: localesLastUpdatedText = "Last Updated" } =
    useLocaleSiteData();

  const { themeConfig } = siteData;
  const lastUpdatedText =
    themeConfig?.lastUpdatedText || localesLastUpdatedText;

  return (
    <div>
      {notEmpty ? (
        postList.map((post) => {
          const { kinds, products } = post;
          const badges = [...kinds, ...products];
          const href = `${base}${post.route}`.replaceAll("//", "/");

          return (
            <LinkCard
              style={{ borderWidth: "0 0 1px 0 ", borderRadius: 0 }}
              title={post.title}
              description={
                <>
                  <div className="line-clamp-2">
                    <Markdown>{post.excerpt}</Markdown>
                  </div>

                  <div className="flex mt-2">
                    {badges.map((badge) => (
                      <div className="mr-2" key={badge}>
                        <Badge>{badge}</Badge>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between">
                    <div className="rp-flex rp-text-sm rp-text-text-2 rp-leading-6 sm:rp-leading-8 rp-font-medium">
                      <p>
                        {lastUpdatedText}: <span>{post.lastUpdatedTime}</span>
                      </p>
                    </div>

                    <DocID id={post.id}></DocID>
                  </div>
                </>
              }
              href={href.endsWith(".html") ? href : `${href}.html`}
              key={post.route}
            ></LinkCard>
          );
        })
      ) : (
        <EmptyState title={t("empty_search")}></EmptyState>
      )}
    </div>
  );
};
