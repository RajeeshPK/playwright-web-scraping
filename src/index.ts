// src/index.ts
import { Page, Frame, ElementHandle, Locator } from 'playwright';

/**
 * @typedef {Object} ExtractedLocator
 * @property {string} locator - The CSS selector for the element.
 * @property {string} name - A human-readable name for the element.
 * @property {number} count - The number of occurrences of this locator on the page.
 */
export interface ExtractedLocator {
    locator: string;
    name: string;
    count: number;
}

/**
 * Options for the locator extraction utility.
 */
export interface LocatorExtractionOptions {
    minElementSize?: number; // Minimum size in pixels for an element to be considered interactable
    dynamicElementObservationInterval?: number; // Interval to check for new elements (ms)
    nameMaxLength?: number; // Max length for extracted element name
}

/**
 * Extracts visible and interactable element locators from a web page.
 * @param {Page} page - The Playwright Page object.
 * @param {LocatorExtractionOptions} options - Options for the extraction process.
 * @returns {Promise<{getLocators: () => ExtractedLocator[], stopObservation: () => void}>}
 */
export async function extractVisibleElementLocators(page: Page, options: LocatorExtractionOptions = {}) {
    const {
        minElementSize = 5,
        dynamicElementObservationInterval = 1000,
        nameMaxLength = 50
    } = options;

    // Store objects with locator, name, and count
    const allFoundElements = new Map<string, ExtractedLocator>(); // Using Map to easily update counts/names by locator string
    let pollingIntervalId: NodeJS.Timeout | null = null;
    let stopPolling = false;

    /**
     * Extracts visibility and bounding box information for an element.
     * @param {ElementHandle} elementHandle
     * @returns {Promise<{isVisible: boolean, width: number, height: number}>}
     */
    async function getElementVisibilityAndBoundingBox(elementHandle: ElementHandle): Promise<{ isVisible: boolean, width: number, height: number }> {
        try {
            const boundingBox = await elementHandle.boundingBox();
            if (!boundingBox) {
                return { isVisible: false, width: 0, height: 0 };
            }

            const { width, height } = boundingBox;

            // Check if element is completely off-screen or has zero dimensions.
            // For truly robust visibility, evaluate computed styles.
            const isActuallyVisible = await elementHandle.evaluate((el: HTMLElement) => {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' &&
                       style.visibility !== 'hidden' &&
                       parseFloat(style.opacity) > 0 &&
                       el.offsetWidth > 0 && el.offsetHeight > 0;
            });

            return { isVisible: isActuallyVisible, width, height };

        } catch (error) {
            // Element might have detached from DOM or other errors
            return { isVisible: false, width: 0, height: 0 };
        }
    }

    /**
     * Generates a robust CSS locator for an element.
     * Prioritizes ID, data-testid, name, then class/tag.
     * @param {ElementHandle} elementHandle
     * @returns {Promise<string|null>}
     */
    async function generateCssLocator(elementHandle: ElementHandle): Promise<string | null> {
        try {
            return await elementHandle.evaluate((el: HTMLElement) => {
                // Prioritize ID
                if (el.id) {
                    // Check if ID is unique on the page (more robust)
                    if (document.querySelectorAll(`#${el.id}`).length === 1) {
                        return `#${el.id}`;
                    }
                }

                // Prioritize data-testid (common in enterprise apps for automation)
                if (el.hasAttribute('data-testid') && el.getAttribute('data-testid')) {
                    return `[data-testid="${el.getAttribute('data-testid')}"]`;
                }
                if (el.hasAttribute('data-test-id') && el.getAttribute('data-test-id')) { // common alternative
                    return `[data-test-id="${el.getAttribute('data-test-id')}"]`;
                }

                // Prioritize name attribute for form elements
                if (el.hasAttribute('name') && el.getAttribute('name')) {
                    return `[name="${el.getAttribute('name')}"]`;
                }

                // Tag name with class names
                let selector = el.tagName.toLowerCase();
                if (el.className) {
                    const classList = Array.from(el.classList).filter(c => c && !c.includes(' ')); // Filter out empty or multi-word classes
                    if (classList.length > 0) {
                        selector += '.' + classList.join('.');
                    }
                }

                // Consider other unique attributes if they exist (e.g., role, type)
                if (el.hasAttribute('role') && el.getAttribute('role')) {
                    selector += `[role="${el.getAttribute('role')}"]`;
                }
                if (el.hasAttribute('type') && el.getAttribute('type')) {
                    selector += `[type="${el.getAttribute('type')}"]`;
                }

                // Fallback: Nth-of-type if selector is not unique
                // This makes it more specific but potentially fragile if siblings change.
                try {
                    if (document.querySelectorAll(selector).length > 1) {
                        const parent = el.parentElement;
                        if (parent) {
                            const siblings = Array.from(parent.children);
                            const sameTagSiblings = siblings.filter(s => s.tagName === el.tagName);
                            const index = sameTagSiblings.indexOf(el) + 1;
                            if (index > 0) {
                                selector += `:nth-of-type(${index})`;
                            }
                        }
                    }
                } catch (e) {
                    // Selector might be invalid if it contains special characters not handled.
                    // console.warn('Error checking selector uniqueness:', e);
                }

                return selector;
            });
        } catch (error: any) {
            console.warn('Could not generate CSS locator:', error.message);
            return null;
        }
    }

    /**
     * Extracts a human-readable name for the element based on priority.
     * @param {ElementHandle} elementHandle
     * @param {number} maxLength
     * @returns {Promise<string>}
     */
    async function getElementName(elementHandle: ElementHandle, maxLength: number): Promise<string> {
        return await elementHandle.evaluate((el: HTMLElement, maxLength: number) => {
            // Priority 1: Associated <label> text
            if (el.id) {
                const label = document.querySelector(`label[for="${el.id}"]`);
                if (label && (label as HTMLElement).innerText) return (label as HTMLElement).innerText.trim().substring(0, maxLength);
            }
            // If the element is directly inside a label
            if (el.parentElement && el.parentElement.tagName.toLowerCase() === 'label' && el.parentElement.innerText) {
                return el.parentElement.innerText.trim().substring(0, maxLength);
            }

            // Priority 2: title attribute
            if (el.hasAttribute('title') && el.getAttribute('title')) {
                return el.getAttribute('title')!.trim().substring(0, maxLength);
            }

            // Priority 3: aria-label attribute
            if (el.hasAttribute('aria-label') && el.getAttribute('aria-label')) {
                return el.getAttribute('aria-label')!.trim().substring(0, maxLength);
            }

            // Priority 4: placeholder attribute for inputs
            if (el.hasAttribute('placeholder') && el.getAttribute('placeholder')) {
                return el.getAttribute('placeholder')!.trim().substring(0, maxLength);
            }

            // Priority 5: alt attribute for images
            if (el.hasAttribute('alt') && el.getAttribute('alt')) {
                return el.getAttribute('alt')!.trim().substring(0, maxLength);
            }

            // Priority 6: innerText (trimmed and truncated)
            if (el.innerText && el.innerText.trim().length > 0) {
                const text = el.innerText.trim();
                return text.substring(0, Math.min(text.length, maxLength));
            }

            // Fallback: Tag name and potentially a class or ID
            let name = el.tagName.toLowerCase();
            if (el.id) name += ` (ID: ${el.id})`;
            else if (el.className) name += ` (Class: ${el.className.split(' ')[0]})`;

            return name.substring(0, maxLength);
        }, maxLength);
    }

    /**
     * Traverses the DOM (including iframes) to extract visible and interactable elements.
     * @param {Page|Frame} context
     */
    async function traverseAndExtract(context: Page | Frame): Promise<void> {
        // Get all elements. Playwright selectors are generally good at piercing shadow DOM.
        const elements = await context.$$('body, body *, [data-testid], [data-test-id], [name]');

        for (const element of elements) {
            const { isVisible, width, height } = await getElementVisibilityAndBoundingBox(element);

            if (!isVisible || width < minElementSize || height < minElementSize) {
                continue; // Element is not visible or too small
            }

            const locator = await generateCssLocator(element);

            if (!locator) {
                continue; // Could not generate a suitable locator
            }

            // Check if this element's parent is also visible and interactable,
            // and if the parent's locator has already been recorded.
            // If so, we prioritize the child and potentially remove the parent.
            try {
                const parentHandle = await element.evaluateHandle((el: HTMLElement) => el.parentElement);
                const parentElement = parentHandle.asElement();
                if (parentElement) {
                    const parentLocator = await generateCssLocator(parentElement);
                    if (parentLocator && allFoundElements.has(parentLocator)) {
                        const { isVisible: parentIsVisible, width: parentWidth, height: parentHeight } = await getElementVisibilityAndBoundingBox(parentElement);
                        if (parentIsVisible && parentWidth >= minElementSize && parentHeight >= minElementSize) {
                            // If parent is also interactable, and its locator is in our list,
                            // we remove the parent's locator to prioritize the child.
                            allFoundElements.delete(parentLocator);
                            // console.log(`Prioritizing child: Removed parent "${parentLocator}" for child "${locator}"`);
                        }
                    }
                }
                await parentHandle.dispose();
            } catch (e) {
                // Parent might have detached
            }

            // Validate locator and count occurrences using Playwright's locator API
            try {
                const playwrightLocator: Locator = context.locator(locator);
                const count = await playwrightLocator.count();

                if (count > 0) {
                    const elementName = await getElementName(element, nameMaxLength);
                    allFoundElements.set(locator, {
                        locator: locator,
                        name: elementName,
                        count: count
                    });
                }
            } catch (validationError: any) {
                // console.warn(`Locator validation failed for "${locator}":`, validationError.message);
            }

            // Handle iframes recursively
            const frameElement = await element.contentFrame();
            if (frameElement) {
                await traverseAndExtract(frameElement);
            }
        }
    }

    // Initial traversal
    await traverseAndExtract(page);

    // Dynamic element observation (polling mechanism)
    async function startDynamicElementObservation(): Promise<void> {
        if (pollingIntervalId) { // Ensure only one interval is running
            clearInterval(pollingIntervalId);
        }
        pollingIntervalId = setInterval(async () => {
            if (stopPolling) {
                if (pollingIntervalId) {
                    clearInterval(pollingIntervalId);
                    pollingIntervalId = null;
                }
                return;
            }
            console.log(`[${new Date().toLocaleTimeString()}] Polling for new elements...`);
            await traverseAndExtract(page); // Re-run traversal
        }, dynamicElementObservationInterval);
    }

    // Start observing dynamic elements immediately
    startDynamicElementObservation();

    return {
        /**
         * Returns the array of extracted locator objects.
         * @returns {ExtractedLocator[]}
         */
        getLocators: (): ExtractedLocator[] => Array.from(allFoundElements.values()),
        /**
         * Stops the dynamic element observation.
         */
        stopObservation: (): void => {
            stopPolling = true;
            if (pollingIntervalId) {
                clearInterval(pollingIntervalId);
                pollingIntervalId = null;
            }
            console.log('Dynamic element observation stopped.');
        }
    };
}