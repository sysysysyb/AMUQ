async function main() {
  await figma.loadAllPagesAsync();

  const styles = await figma.getLocalTextStylesAsync();
  const stylesById = new Map(styles.map((style) => [style.id, style]));
  const stylesByName = new Map();

  for (const style of styles) {
    stylesByName.set(style.name.replace(/^Text\//, ""), style);
  }

  const loadedFonts = new Set();
  const loadFont = async (fontName) => {
    const key = `${fontName.family}:${fontName.style}`;
    if (loadedFonts.has(key)) return;
    await figma.loadFontAsync(fontName);
    loadedFonts.add(key);
  };

  let refreshed = 0;
  let instanceRefreshed = 0;
  let skipped = 0;
  const failures = [];

  figma.skipInvisibleInstanceChildren = false;

  for (const page of figma.root.children) {
    const textNodes = page.findAllWithCriteria({ types: ["TEXT"] });

    for (const node of textNodes) {
      let parent = node.parent;
      let insideInstance = false;
      while (parent && parent.type !== "PAGE") {
        if (parent.type === "INSTANCE") {
          insideInstance = true;
          break;
        }
        parent = parent.parent;
      }

      const currentStyle =
        typeof node.textStyleId === "string"
          ? stylesById.get(node.textStyleId)
          : undefined;
      const namedStyle = stylesByName.get(node.name.replace(/^Text\//, ""));
      const style = currentStyle ?? namedStyle;

      if (!style || style.fontName.family !== "Pretendard") {
        skipped += 1;
        continue;
      }

      try {
        const segments = node.getStyledTextSegments(["fontName"]);
        for (const segment of segments) await loadFont(segment.fontName);
        await loadFont(style.fontName);

        // Reassigning the same style ID can be a no-op. Setting the font first
        // forces Figma to resolve the local font, then the style link is restored.
        node.fontName = style.fontName;
        await node.setTextStyleIdAsync(style.id);
        refreshed += 1;
        if (insideInstance) instanceRefreshed += 1;
      } catch (error) {
        failures.push(`${page.name} / ${node.name}: ${error.message}`);
      }
    }
  }

  const failed = failures.length;
  const suffix = failed ? ` 실패 ${failed}개: ${failures[0]}` : "";
  figma.closePlugin(
    `Pretendard 스타일 ${refreshed}개를 갱신했습니다. 인스턴스 내부 ${instanceRefreshed}개, 건너뜀 ${skipped}개.${suffix}`,
  );
}

main().catch((error) => {
  figma.closePlugin(`Pretendard 갱신 실패: ${error.message}`);
});
