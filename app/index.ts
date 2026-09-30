import { registerRootComponent } from 'expo';

import App from './App';
import { installCrashLogger } from './src/debug/breadcrumbs';

// Record uncaught errors and scan-step breadcrumbs to a file, so a release-build
// crash can be diagnosed after the restart.
installCrashLogger();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
