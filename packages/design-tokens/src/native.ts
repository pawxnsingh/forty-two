import { resolvedShared } from "./resolved.js";
import { themes } from "./themes.js";

const nativeFontFamilies = {
  display: "Sanchez",
  body: "LeagueSpartan",
  mono: "JetBrainsMono",
} as const;

const nativeTypography = {
  display: { ...resolvedShared.type.display, family: nativeFontFamilies.display },
  heading: { ...resolvedShared.type.heading, family: nativeFontFamilies.display },
  title: { ...resolvedShared.type.title, family: nativeFontFamilies.display },
  subtitle: { ...resolvedShared.type.subtitle, family: nativeFontFamilies.body },
  bodyLarge: { ...resolvedShared.type.bodyLarge, family: nativeFontFamilies.body },
  body: { ...resolvedShared.type.body, family: nativeFontFamilies.body },
  bodySmall: { ...resolvedShared.type.bodySmall, family: nativeFontFamilies.body },
  label: { ...resolvedShared.type.label, family: nativeFontFamilies.body },
  caption: { ...resolvedShared.type.caption, family: nativeFontFamilies.body },
  overline: { ...resolvedShared.type.overline, family: nativeFontFamilies.body },
  code: { ...resolvedShared.type.code, family: nativeFontFamilies.mono },
  data: { ...resolvedShared.type.data, family: nativeFontFamilies.mono },
} as const;

export const nativeTokens = {
  themes,
  shared: {
    ...resolvedShared,
    type: nativeTypography,
  },
  fontFamilies: nativeFontFamilies,
  fontAssets: {
    sanchezRegular: "../assets/fonts/native/Sanchez-Regular.ttf",
    sanchezItalic: "../assets/fonts/native/Sanchez-Italic.ttf",
    leagueSpartanRegular: "../assets/fonts/native/LeagueSpartan-Regular.ttf",
    leagueSpartanMedium: "../assets/fonts/native/LeagueSpartan-Medium.ttf",
    leagueSpartanSemiBold: "../assets/fonts/native/LeagueSpartan-SemiBold.ttf",
    leagueSpartanBold: "../assets/fonts/native/LeagueSpartan-Bold.ttf",
    jetBrainsMonoRegular: "../assets/fonts/native/JetBrainsMono-Regular.ttf",
    jetBrainsMonoMedium: "../assets/fonts/native/JetBrainsMono-Medium.ttf",
  },
} as const;
