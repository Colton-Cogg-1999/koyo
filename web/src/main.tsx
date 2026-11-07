import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/newsreader/wght-italic.css';
import '@fontsource-variable/literata';
import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startTheme } from './theme';
import './styles.css';

/** A rendering error shows as a message with a way out, never a blank window. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <p>ERR&gt; {this.state.error.message}</p>
        <button className="solid" onClick={() => { location.hash = '#/library'; location.reload(); }}>back to library</button>
      </div>
    );
  }
}

startTheme();
createRoot(document.getElementById('root')!).render(<Boundary><App /></Boundary>);
