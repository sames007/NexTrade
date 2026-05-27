import '../app/globals.css';
import Head from 'next/head';

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        <title>NexTrade | Smart Market Intelligence</title>
        <meta
          name="description"
          content="NexTrade tracks provider-sourced market data, financial news, crypto, and AI-assisted insights."
        />
        <meta name="theme-color" content="#07120f" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
