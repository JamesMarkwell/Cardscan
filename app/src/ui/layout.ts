/** Screen geometry shared by the screens. */
import { Platform, StatusBar } from 'react-native';

/** Clearance for the status bar (the app draws edge to edge), so titles don't sit under the clock. */
export const topInset: number = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 28) : 48;
