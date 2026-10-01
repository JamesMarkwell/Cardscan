/** A card picture at the card aspect ratio, with a plain placeholder until (or instead of) the image. */
import React, { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { theme } from './theme';

const CARD_ASPECT = 63 / 88;

export function CardImage({ uri, width, label }: { uri: string | null | undefined; width: number; label?: string }) {
  const [failed, setFailed] = useState(false);
  const height = Math.round(width / CARD_ASPECT);

  return (
    <View style={[styles.frame, { width, height }]}>
      {uri && !failed ? (
        <Image
          source={{ uri }}
          style={{ width, height }}
          resizeMode="cover"
          onError={() => setFailed(true)}
          accessibilityLabel={label}
        />
      ) : (
        <Text style={styles.missing} numberOfLines={3}>
          {label ?? 'No image'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  missing: { color: theme.textMuted, fontSize: 10, textAlign: 'center', padding: 4 },
});
