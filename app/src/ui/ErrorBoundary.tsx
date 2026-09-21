/**
 * Catches render-time failures.
 *
 * A release build has no red error screen: an uncaught JavaScript error during
 * the first render takes the whole app down with nothing shown, which looks
 * exactly like a native crash. This draws the error instead, so the two can be
 * told apart without a cable and adb.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from './theme';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // Also goes to logcat, where a native crash would show up too.
    console.error('CardScan failed to render', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render(): React.ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.container}>
        <Text style={styles.title}>CardScan hit an error starting up</Text>
        <Text style={styles.message}>{error.message || String(error)}</Text>
        <ScrollView style={styles.stack}>
          <Text style={styles.stackText}>{error.stack ?? ''}</Text>
          {componentStack ? <Text style={styles.stackText}>{componentStack}</Text> : null}
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background, padding: theme.spacing(3), paddingTop: theme.spacing(8), gap: theme.spacing(1) },
  title: { color: theme.text, fontSize: 18, fontWeight: '700' },
  message: { color: theme.low, fontSize: 14 },
  stack: { flex: 1, marginTop: theme.spacing(1) },
  stackText: { color: theme.textMuted, fontSize: 11, fontFamily: 'monospace' },
});
