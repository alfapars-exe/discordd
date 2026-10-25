import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getRecommendations, type PersonalizationRecommendations } from "../../api/personalization";

export default function PersonalizedSuggestions() {
  const { t } = useTranslation("common");
  const [result, setResult] = useState<PersonalizationRecommendations | null>(null);

  useEffect(() => {
    let active = true;
    void getRecommendations().then((response) => {
      if (active && response.success && response.data) setResult(response.data);
    });
    return () => { active = false; };
  }, []);

  if (!result?.enabled || result.items.length === 0) return null;
  return (
    <aside className="fv-personalized" aria-label={t("personalizedSuggestions.title")}>
      <strong>{t("personalizedSuggestions.title")}</strong>
      <ul>
        {result.items.map((item) => <li key={item}>{t(`personalizedSuggestions.${item}`)}</li>)}
      </ul>
    </aside>
  );
}
