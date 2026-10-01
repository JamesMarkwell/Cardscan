/** The CardScan logo and wordmark. */
import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { theme } from './theme';

export function BrandHeader({ subtitle }: { subtitle?: string }) {
  return (
    <View style={styles.row}>
      <Image source={require('../../assets/logo.png')} style={styles.logo} resizeMode="contain" accessibilityLabel="CardScan logo" />
      <View>
        <Text style={styles.wordmark}>
          Card<Text style={styles.wordmarkAccent}>Scan</Text>
        </Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.5) },
  logo: { width: 48, height: 48 },
  wordmark: { color: theme.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  wordmarkAccent: { color: theme.accent },
  subtitle: { color: theme.textMuted, fontSize: 12 },
});
