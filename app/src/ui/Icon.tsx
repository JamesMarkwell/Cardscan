/** The app's line icons: white glyphs tinted to whatever colour is asked for. */
import React from 'react';
import { Image } from 'react-native';

const ICONS = {
  home: require('../../assets/tabs/home.png'),
  scan: require('../../assets/tabs/scan.png'),
  collection: require('../../assets/tabs/collection.png'),
  settings: require('../../assets/tabs/settings.png'),
  search: require('../../assets/tabs/search.png'),
  plus: require('../../assets/tabs/plus.png'),
  sort: require('../../assets/tabs/sort.png'),
  select: require('../../assets/tabs/select.png'),
  grid: require('../../assets/tabs/grid.png'),
  list: require('../../assets/tabs/list.png'),
  filter: require('../../assets/tabs/filter.png'),
  trash: require('../../assets/tabs/trash.png'),
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 24, color }: { name: IconName; size?: number; color: string }) {
  return <Image source={ICONS[name]} style={{ width: size, height: size, tintColor: color }} resizeMode="contain" />;
}
