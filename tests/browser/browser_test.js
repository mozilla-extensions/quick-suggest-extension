/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

XPCOMUtils.defineLazyModuleGetters(this, {
  ContentTaskUtils: "resource://testing-common/ContentTaskUtils.jsm",
  PlacesTestUtils: "resource://testing-common/PlacesTestUtils.jsm",
  SearchTestUtils: "resource://testing-common/SearchTestUtils.jsm",
  UrlbarPrefs: "resource:///modules/UrlbarPrefs.jsm",
  UrlbarProvidersManager: "resource:///modules/UrlbarProvidersManager.jsm",
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.jsm",
});

// The path of the add-on file relative to `getTestFilePath`.
const ADDON_PATH = "firefox-quick-suggest-keyword.xpi";
const ABOUT_BLANK = "about:blank";
const URLBAR_PROVIDER_NAME = "ProviderDynamicQuickSuggest";

const SUGGESTIONS_PREF = "browser.search.suggest.enabled";
const PRIVATE_SUGGESTIONS_PREF = "browser.search.suggest.enabled.private";

const ATTRIBUTION_URL =
  "http://mochi.test:8888/browser/testing/extensions/browser/qs_attribution.sjs?";

// Use SIGNEDSTATE_MISSING when testing an unsigned, in-development version of
// the add-on and SIGNEDSTATE_PRIVILEGED when testing the production add-on.
const EXPECTED_ADDON_SIGNED_STATE = AddonManager.SIGNEDSTATE_MISSING;
// const EXPECTED_ADDON_SIGNED_STATE = AddonManager.SIGNEDSTATE_PRIVILEGED;

SearchTestUtils.init(this);

function sleep(ms) {
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForProcessesScalars(
  aProcesses,
  aKeyed,
  aAdditionalCondition = data => true
) {
  await ContentTaskUtils.waitForCondition(() => {
    const scalars = aKeyed
      ? Services.telemetry.getSnapshotForKeyedScalars("main", false)
      : Services.telemetry.getSnapshotForScalars("main", false);
    return (
      aProcesses.every(p => Object.keys(scalars).includes(p)) &&
      aAdditionalCondition(scalars)
    );
  });
}

async function getAttributionHits() {
  let req = await fetch(ATTRIBUTION_URL + "?ignore=true");
  let data = await req.text();
  return parseInt(data, 10);
}

add_task(async function init() {
  await PlacesUtils.history.clear();
  await PlacesUtils.bookmarks.eraseEverything();

  await Services.search.init();

  await initAddonTest(ADDON_PATH, EXPECTED_ADDON_SIGNED_STATE);

  let searchExtensions = getChromeDir(getResolvedURI(gTestPath));
  searchExtensions.append("data");
  await SearchTestUtils.useMochitestEngines(searchExtensions);

  SearchTestUtils.useMockIdleService();
  let response = await fetch(`resource://search-extensions/engines.json`);
  let json = await response.json();
  await SearchTestUtils.updateRemoteSettingsConfig(json.data);

  SpecialPowers.setCharPref("browser.partnerlink.attributionURL", "");
});

add_task(async function basic_test() {
  await withAddon(async () => {
    await BrowserTestUtils.withNewTab(ABOUT_BLANK, async () => {
      gURLBar.focus();
      EventUtils.sendString("frab");
      EventUtils.synthesizeKey("KEY_ArrowDown");
      EventUtils.synthesizeKey("KEY_Enter");
      await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
      Assert.ok(
        /q=frabbits/.test(gBrowser.currentURI.spec),
        "Selecting first result visits suggestions URL"
      );
    });
  });
});

add_task(async function test_attribution() {
  await PlacesUtils.history.clear();
  SpecialPowers.setCharPref(
    "browser.partnerlink.attributionURL",
    ATTRIBUTION_URL
  );

  Assert.equal(
    0,
    await getAttributionHits(),
    "Should have no attributions yet"
  );

  await withAddon(async () => {
    await BrowserTestUtils.withNewTab(ABOUT_BLANK, async () => {
      gURLBar.focus();
      EventUtils.sendString("frab");
      EventUtils.synthesizeKey("KEY_ArrowDown");
      EventUtils.synthesizeKey("KEY_Enter");
      await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
      Assert.ok(
        /q=frabbits/.test(gBrowser.currentURI.spec),
        "Selecting first result visits suggestions URL"
      );
    });
  });

  Assert.equal(1, await getAttributionHits(), "Search should be attributed");
  SpecialPowers.setCharPref("browser.partnerlink.attributionURL", "");
});

add_task(async function test_suggestions_disabled() {
  await PlacesUtils.history.clear();
  await SpecialPowers.setBoolPref(SUGGESTIONS_PREF, false);

  await withAddon(async () => {
    await BrowserTestUtils.withNewTab(ABOUT_BLANK, async () => {
      gURLBar.focus();
      EventUtils.sendString("frab");
      // We can't waitForResultAt because we don't want a result, give enough time
      // that a result would most likely have appeared.
      await sleep(500);
      Assert.ok(
        window.gURLBar.view._rows.children.length == 1,
        "There are no additional suggestions"
      );
    });
  });

  SpecialPowers.clearUserPref(SUGGESTIONS_PREF);
});

add_task(async function test_suggestions_disabled_private() {
  await PlacesUtils.history.clear();
  await SpecialPowers.setBoolPref(SUGGESTIONS_PREF, true);
  await SpecialPowers.setBoolPref(PRIVATE_SUGGESTIONS_PREF, false);

  await withAddon(async () => {
    let win = await BrowserTestUtils.openNewBrowserWindow({
      private: true,
    });
    let browser = win.gBrowser.selectedTab.linkedBrowser;
    BrowserTestUtils.loadURI(browser, ABOUT_BLANK);
    await BrowserTestUtils.browserLoaded(browser, false, ABOUT_BLANK);
    win.gURLBar.focus();
    EventUtils.sendString("frab", win);
    // We can't waitForResultAt because we don't want a result, give enough time
    // that a result would most likely have appeared.
    await sleep(500);
    Assert.ok(
      win.gURLBar.view._rows.children.length == 1,
      "There are no additional suggestions"
    );
    await BrowserTestUtils.closeWindow(win);
  });

  SpecialPowers.clearUserPref(SUGGESTIONS_PREF);
  SpecialPowers.clearUserPref(PRIVATE_SUGGESTIONS_PREF);
});

add_task(async function test_telemetry_no_impressions() {
  await PlacesUtils.history.clear();
  Services.telemetry.clearScalars();
  await withAddon(async () => {
    await BrowserTestUtils.withNewTab(ABOUT_BLANK, async () => {
      gURLBar.focus();
      EventUtils.sendString("frab123");
      await UrlbarTestUtils.promisePopupClose(window, () =>
        window.gURLBar.blur()
      );

      let scalars = TelemetryTestUtils.getProcessScalars("dynamic", true, true);
      Assert.ok(
        !("dynamic" in scalars),
        "Should not have recorded dynamic scalars"
      );
    });
  });
});

add_task(async function test_telemetry_impressions() {
  await PlacesUtils.history.clear();
  Services.telemetry.clearScalars();
  await withAddon(async () => {
    await BrowserTestUtils.withNewTab(ABOUT_BLANK, async () => {
      gURLBar.focus();
      EventUtils.sendString("frab");
      EventUtils.synthesizeKey("KEY_ArrowDown");
      EventUtils.synthesizeKey("KEY_Enter");
      await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
      Assert.ok(
        /q=frabbits/.test(gBrowser.currentURI.spec),
        "Selecting first result visits suggestions URL"
      );

      await waitForProcessesScalars(["dynamic"], true, scalars => {
        // Wait for the scalars set in the content process to be available.
        return (
          "browser.search.experiments.impressions" in scalars.dynamic &&
          "browser.search.experiments.impressions_at_end" in scalars.dynamic
        );
      });

      let scalars = TelemetryTestUtils.getProcessScalars("dynamic", true, true);
      TelemetryTestUtils.assertKeyedScalar(
        scalars,
        "browser.search.experiments.impressions",
        URLBAR_PROVIDER_NAME,
        1
      );
      TelemetryTestUtils.assertKeyedScalar(
        scalars,
        "browser.search.experiments.impressions_at_end",
        URLBAR_PROVIDER_NAME,
        1
      );
    });
  });
});

/*add_task(async function test_telemetry_multiple_impressions() {
  await PlacesUtils.history.clear();
  Services.telemetry.clearScalars();
  await withAddon(async () => {
    await BrowserTestUtils.withNewTab(ABOUT_BLANK, async () => {
      gURLBar.focus();
      EventUtils.sendString("fra");
      await UrlbarTestUtils.waitForAutocompleteResultAt(window, 1);
      EventUtils.sendString("b");
      EventUtils.synthesizeKey("KEY_ArrowDown");
      EventUtils.synthesizeKey("KEY_Enter");
      await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
      Assert.ok(
        /q=frabbits/.test(gBrowser.currentURI.spec),
        "Selecting first result visits suggestions URL"
      );

      await waitForProcessesScalars(["dynamic"], true, scalars => {
        // Wait for the scalars set in the content process to be available.
        return (
          "browser.search.experiments.impressions" in scalars.dynamic &&
          "browser.search.experiments.impressions_at_end" in scalars.dynamic
        );
      });

      let scalars = TelemetryTestUtils.getProcessScalars("dynamic", true, true);
      TelemetryTestUtils.assertKeyedScalar(
        scalars,
        "browser.search.experiments.impressions",
        URLBAR_PROVIDER_NAME,
        1
      );
      TelemetryTestUtils.assertKeyedScalar(
        scalars,
        "browser.search.experiments.impressions_at_end",
        URLBAR_PROVIDER_NAME,
        1
      );
    });
  });
});

add_task(async function test_telemetry_impressions_not_showing_at_end() {
  await PlacesUtils.history.clear();
  Services.telemetry.clearScalars();
  await withAddon(async () => {
    await BrowserTestUtils.withNewTab(ABOUT_BLANK, async browser => {
      gURLBar.focus();
      EventUtils.sendString("frab");
      await UrlbarTestUtils.waitForAutocompleteResultAt(window, 1);
      EventUtils.sendString("d");
      EventUtils.synthesizeKey("KEY_ArrowDown");
      EventUtils.synthesizeKey("KEY_Enter");

      await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
      Assert.equal(
        gBrowser.currentURI.spec,
        "https://example.com/search?q=frabd",
        "Selecting first result visits suggestions URL"
      );

      await waitForProcessesScalars(["dynamic"], true, scalars => {
        // Wait for the scalars set in the content process to be available.
        return "browser.search.experiments.impressions" in scalars.dynamic;
      });

      let scalars = TelemetryTestUtils.getProcessScalars("dynamic", true, true);
      TelemetryTestUtils.assertKeyedScalar(
        scalars,
        "browser.search.experiments.impressions",
        URLBAR_PROVIDER_NAME,
        1
      );
      Assert.ok(
        !("browser.search.experiments.impressions_at_end" in scalars),
        "Should not have recorded impressions_at_end scalar"
      );
    });
  });
});*/
