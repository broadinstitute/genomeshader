# Changelog

## [0.2.0](https://github.com/broadinstitute/genomeshader/compare/v0.1.91...v0.2.0) (2026-01-22)


### Features

* add real reference sequence support from UCSC API ([090bd0f](https://github.com/broadinstitute/genomeshader/commit/090bd0f3202359a8dbfff01949b27dc163c664b8))
* allow alleles to be reordered by drag-and-drop ([b621772](https://github.com/broadinstitute/genomeshader/commit/b6217726ef46834520c12f5e2e2fc7ed00c4acf4))
* first fully working version of alleuvial display ([9f6c647](https://github.com/broadinstitute/genomeshader/commit/9f6c647cd894426ef7e76f2c3b0c6a56e9a63344))
* first implementation of Smart Tracks ([6b7f71b](https://github.com/broadinstitute/genomeshader/commit/6b7f71b16cbdb69f278620773bf314907daae7f8))
* **gpu:** add WebGPU canvas support for tracks rendering ([e66d4fc](https://github.com/broadinstitute/genomeshader/commit/e66d4fc1c58bb2c27107c904363dc4809177b817))
* **gpu:** add WebGPU canvas support for tracks rendering ([6e32f23](https://github.com/broadinstitute/genomeshader/commit/6e32f233358743fb8b5e6504f4265468c0e27af6))
* loading random samples that have an allele now works ([353dc26](https://github.com/broadinstitute/genomeshader/commit/353dc26e7466c9ed4cf0b4eda4d1414de70d2b2a))
* render variant track using WebGPU ([bf48013](https://github.com/broadinstitute/genomeshader/commit/bf4801392e1a2650440d3ef4feada499e96179cd))
* show a union of transcripts rather than individual genes ([80347f8](https://github.com/broadinstitute/genomeshader/commit/80347f82d3d50bd0a1a0fa71ea3e1e0147571a34))
* show reads ([7dd0747](https://github.com/broadinstitute/genomeshader/commit/7dd07477b754d34ceb87dce7ddc2e2ab2c2dafa0))
* smart track's random loading strategy now working ([1cbb68f](https://github.com/broadinstitute/genomeshader/commit/1cbb68f951cf22e687d17fac2f540387ddf84eb9))
* split monolithic HTML into separate files for easier development ([17154d6](https://github.com/broadinstitute/genomeshader/commit/17154d6b72b9c0744cb967c29b029b7b3eb77d9c))
* split monolithic HTML into separate files for easier development ([e1291de](https://github.com/broadinstitute/genomeshader/commit/e1291ded57677053438621ac88b1878e5adcad8d))
* **ui:** improve data bounds overlay rendering ([27be2cb](https://github.com/broadinstitute/genomeshader/commit/27be2cb55b545e15e29882a057ab2d744a86faf9))
* **view:** refactor genes() method with robust UCSC API parsing and transcript transformation ([6f90769](https://github.com/broadinstitute/genomeshader/commit/6f9076923593fb93287e68e1f87b09ee3d71bd80))


### Bug Fixes

* added debugging buttons to examine click events ([690f936](https://github.com/broadinstitute/genomeshader/commit/690f9366b283187017c8df1e32e8db581a2ca80f))
* adjusting read drawing ([8242f45](https://github.com/broadinstitute/genomeshader/commit/8242f45a32c9add9330082dc5081a5213603ca24))
* allow scrolling on read tracks ([0f317da](https://github.com/broadinstitute/genomeshader/commit/0f317da0a500f96dd7c83e6725b873bbd4691a3e))
* **ci:** trigger publish workflow after release-please completes ([40a7892](https://github.com/broadinstitute/genomeshader/commit/40a7892a243eb4674f6576b215fc2338da258b81))
* debugging gear menu and sidebar toggle ([9cd1524](https://github.com/broadinstitute/genomeshader/commit/9cd1524f0271ccb1edbe7d7cd70e7037062d7cfd))
* default number of samples to load is now 1 ([3915f44](https://github.com/broadinstitute/genomeshader/commit/3915f4426bb345d744427a5bc123f6bc6189c231))
* do not draw overlay on in-bounds region ([854db20](https://github.com/broadinstitute/genomeshader/commit/854db20ac14102563dafb638a29bf78fae0ed2dc))
* draw an indicator for where dragged allele will land ([1b23177](https://github.com/broadinstitute/genomeshader/commit/1b231774c4d0bc8aa640cd42ac50d50a777fe0f7))
* fix allele coloring ([97cdc0a](https://github.com/broadinstitute/genomeshader/commit/97cdc0acb9465ec6059b1279a030c36e5c0f8c40))
* fix panning direction ([bfdd487](https://github.com/broadinstitute/genomeshader/commit/bfdd4873747b5488bdb89ee8d67f7c3f529cf1f6))
* fixed an error where flow was null when accessing flow.style ([1b12956](https://github.com/broadinstitute/genomeshader/commit/1b12956c4ede33b7037a5decc9d82955f3d787f4))
* fixed menu and sidebar ([f7262eb](https://github.com/broadinstitute/genomeshader/commit/f7262ebf97bbbc305db2dfde3c13905c8c672706))
* fixed publishing workflow ([cd27327](https://github.com/broadinstitute/genomeshader/commit/cd273276c0ff19661b1de513b53f868a74338605))
* fixed publishing workflow ([b9efb40](https://github.com/broadinstitute/genomeshader/commit/b9efb40ebb86158eafee49555cf874a5fa7dc121))
* fixed Sankey diagram in Vertical mode ([c96a246](https://github.com/broadinstitute/genomeshader/commit/c96a2462696c65498f4e678cea1b7858c6972623))
* fixed sidebar activation ([e93da7a](https://github.com/broadinstitute/genomeshader/commit/e93da7a2114359d09a3cd9f06f8d774a7ce75482))
* fixed some visualization artifacts ([0dedffa](https://github.com/broadinstitute/genomeshader/commit/0dedffa34f57241bbf15fa19aa08ec3c97336c7f))
* Fixed window name ([c5498db](https://github.com/broadinstitute/genomeshader/commit/c5498db8c6790dff156aa4ffb893ffd576a2d77b))
* fixes for vertical mode ([4c0b153](https://github.com/broadinstitute/genomeshader/commit/4c0b153ddc41c227949c20bc1cd0654de1133dcd))
* fullscreen mode now kinda working ([099f3cb](https://github.com/broadinstitute/genomeshader/commit/099f3cbe2c477e48a7bac033ae7dfe4fa20acc08))
* hide participant groups for now ([688f0be](https://github.com/broadinstitute/genomeshader/commit/688f0be055a8fa24f18e4eecfff625652dc5c95c))
* improved smart track controls ([5640677](https://github.com/broadinstitute/genomeshader/commit/5640677dbd45de2441bc424cfa6f8fbe3dbc3970))
* improvements in how allele nodes are rendered ([cf064d8](https://github.com/broadinstitute/genomeshader/commit/cf064d8c2edd6dd90e09dd85384f473556b3f068))
* improvements to reads display ([2f9ff1b](https://github.com/broadinstitute/genomeshader/commit/2f9ff1b117ca738b9f989130cdaf07ec604856ff))
* Improvements to shading and locus reporting ([e5f05ac](https://github.com/broadinstitute/genomeshader/commit/e5f05ac67217c751bfd835ba54f7c9b8142037d8))
* improving allele display ([d54261c](https://github.com/broadinstitute/genomeshader/commit/d54261ce45e896e3cf2158bfe2839b14d5402e10))
* minor cosmetic fixes ([1db3ec5](https://github.com/broadinstitute/genomeshader/commit/1db3ec58623510e1a2b3af1950ee95bc3febe4d5))
* minor fixes to allele illustration ([28bdf46](https://github.com/broadinstitute/genomeshader/commit/28bdf465c7a97117c1230ef3454f09f0f50b4f0c))
* minor fixes to display ([2311214](https://github.com/broadinstitute/genomeshader/commit/231121442dbff3d04e7032b5a6d23ec738414ff4))
* minor improvements to alleuvial diagram aesthetics ([b5c2709](https://github.com/broadinstitute/genomeshader/commit/b5c27094b0eec82ef13772849bacfbfa2ed0e91d))
* minor updates to track heights ([89d2cc0](https://github.com/broadinstitute/genomeshader/commit/89d2cc06961834386a74b37e346b9dce5cbb692e))
* misc changes ([316dc61](https://github.com/broadinstitute/genomeshader/commit/316dc611e56d43163bef4505b69471d48307c2e1))
* moar make bug stop ([0294e3a](https://github.com/broadinstitute/genomeshader/commit/0294e3a37478e30fee606488e2c8b99fd47fbd69))
* more debugging ([60cb7ef](https://github.com/broadinstitute/genomeshader/commit/60cb7ef632bd021b71af43a2877636eb252e64a0))
* moved status bar in vertical mode ([1e9f39e](https://github.com/broadinstitute/genomeshader/commit/1e9f39e001f5b9dc2aa7e80eacb961f7438aff37))
* **publish:** remove ubuntu-latest aarch64 build from workflow ([be5ecba](https://github.com/broadinstitute/genomeshader/commit/be5ecba505e7404fc3a1c83e331af9a722b20d0b))
* **publish:** remove ubuntu-latest aarch64 build from workflow ([e8684fe](https://github.com/broadinstitute/genomeshader/commit/e8684fe0c8ac2ce51abd5cc4ee5a66c9d5d7e58d))
* reference bases are now painted ([ada00ae](https://github.com/broadinstitute/genomeshader/commit/ada00aeb4b85919e940e9f6200ec35281defbec5))
* remove smart-track-strategy-select menus from track controls ([8e98c28](https://github.com/broadinstitute/genomeshader/commit/8e98c28006cf9d543cbbf460c4b76359e8e49e10))
* removed debug toolbar ([c75f6ac](https://github.com/broadinstitute/genomeshader/commit/c75f6ac7f29998748caac6c8917f983b6113da54))
* removed load reads button from settings menu ([c08ac9c](https://github.com/broadinstitute/genomeshader/commit/c08ac9c9ecd9c6c24c200f0756ee23cd77b4fe52))
* removed reads track (smart tracks will now visualize reads) ([4554d73](https://github.com/broadinstitute/genomeshader/commit/4554d73011f595fc806d2743c08e7441ce67c5b8))
* scrolling in inline mode is now limited to visualization area ([b435d93](https://github.com/broadinstitute/genomeshader/commit/b435d9366bf0f7d18d8edf2c8680171b3f5ab232))
* scrolling in overlay mode now works ([e38b4c3](https://github.com/broadinstitute/genomeshader/commit/e38b4c33a33cfcf90cfe25715b122b6fa6146e43))
* sideba controls now work properly ([995eda1](https://github.com/broadinstitute/genomeshader/commit/995eda1d9d67175fd98173a5ed41ee1e68e030c0))
* sidebar formatting ([53335b6](https://github.com/broadinstitute/genomeshader/commit/53335b635e49f637ae3006f4aa5b79c74f63b3fd))
* smart track collapse now works properly ([f8c1469](https://github.com/broadinstitute/genomeshader/commit/f8c1469d3d4185d801253ad73ee967e0acfe3b9a))
* sped up finding relevant samples ([387c28c](https://github.com/broadinstitute/genomeshader/commit/387c28cb3cf458d5be130eaab32c2671af1dc3b5))
* **ui:** improve RepeatMasker track coordinate tracking and hit testing ([95ccaf6](https://github.com/broadinstitute/genomeshader/commit/95ccaf661cc3ac50b8fda8ac106f8ce1d0cde34d))

## [0.1.91](https://github.com/broadinstitute/genomeshader/compare/v0.1.90...v0.1.91) (2025-12-29)


### Bug Fixes

* refined release process ([430274e](https://github.com/broadinstitute/genomeshader/commit/430274ec45219a6b50903e8ae7dfe2d1acc3549b))
* **ui:** add chromosome bounds checking and fix variant indexing ([98b4de9](https://github.com/broadinstitute/genomeshader/commit/98b4de94d3eb74f174199f2496bdfa2da3c9ed9a))
* **ui:** add chromosome bounds checking and fix variant indexing ([55ee807](https://github.com/broadinstitute/genomeshader/commit/55ee807227940c2b3f3492bb0163d72002c12fd7))

## [0.1.90](https://github.com/broadinstitute/genomeshader/compare/0.1.89...v0.1.90) (2025-12-28)


### Bug Fixes

* configure release-please to use config file and full git history ([46d8e61](https://github.com/broadinstitute/genomeshader/commit/46d8e6122d4113e5be3f890ea42563688efcd5d5))
* configure release-please to use config file and full git history ([c914587](https://github.com/broadinstitute/genomeshader/commit/c914587feeb03f9e9a58234c6c62aeb6b3ffcf37))


### Miscellaneous

* modernize build and release process with release-please ([8500372](https://github.com/broadinstitute/genomeshader/commit/850037284a25e5bb1b11f01fd225603e011a99a6))
* modernize build and release process with release-please ([b9863e8](https://github.com/broadinstitute/genomeshader/commit/b9863e8fd77f00cc9feb0d2fdbea3e1809ee7f30))
